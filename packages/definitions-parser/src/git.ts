import assert from "assert";
import { sourceBranch } from "./lib/settings";
import {
  PackageId,
  DirectoryParsedTypingVersion,
  getDependencyFromFile,
  formatTypingVersion,
  AllPackages,
  NotNeededPackage,
} from "./packages";
import {
  Logger,
  execAndThrowErrors,
  flatMapIterable,
  mapIterable,
  mapDefined,
  consoleLogger,
  assertDefined,
  cacheDir,
} from "@definitelytyped/utils";
import * as pacote from "pacote";
import * as semver from "semver";
import { inspect } from 'util'
import { PreparePackagesResult, getAffectedPackages } from "./get-affected-packages";

export interface GitDiff {
  status: "A" | "D" | "M";
  file: string;
}

/*
We have to be careful about how we get the diff because travis uses a shallow clone.

Travis runs:
    git clone --depth=50 https://github.com/DefinitelyTyped/DefinitelyTyped.git DefinitelyTyped
    cd DefinitelyTyped
    git fetch origin +refs/pull/123/merge
    git checkout -qf FETCH_HEAD

If editing this code, be sure to test on both full and shallow clones.
*/
export async function gitDiff(log: Logger, definitelyTypedPath: string): Promise<GitDiff[]> {
  try {
    await run(`git rev-parse --verify ${sourceBranch}`);
    // If this succeeds, we got the full clone.
  } catch (_) {
    // This is a shallow clone.
    await run(`git fetch origin ${sourceBranch}`);
    await run(`git branch ${sourceBranch} FETCH_HEAD`);
  }

  let diff = (await run(`git diff ${sourceBranch} --name-status`)).trim();
  if (diff === "") {
    // We are probably already on master, so compare to the last commit.
    diff = (await run(`git diff ${sourceBranch}~1 --name-status`)).trim();
  }
  return diff.split("\n").map((line) => {
    const [status, file] = line.split(/\s+/, 2);
    return { status: status.trim(), file: file.trim() } as GitDiff;
  });

  async function run(cmd: string): Promise<string> {
    log(`Running: ${cmd}`);
    const stdout = await execAndThrowErrors(cmd, definitelyTypedPath);
    log(stdout);
    return stdout;
  }
}
/** Returns all immediate subdirectories of the root directory that have changed. */
function gitDeletions(diffs: GitDiff[]): PackageId[] {
  const changedPackages = new Map<string, Map<string, DirectoryParsedTypingVersion | "*">>();
  for (const diff of diffs) {
    if (diff.status !== "D") continue
    const dep = getDependencyFromFile(diff.file);
    if (dep) {
      const versions = changedPackages.get(dep.name);
      if (!versions) {
        changedPackages.set(dep.name, new Map([[formatDependencyVersion(dep.version), dep.version]]));
      } else {
        versions.set(formatDependencyVersion(dep.version), dep.version);
      }
    }
  }
   
  return Array.from(
    flatMapIterable(changedPackages, ([name, versions]) => mapIterable(versions, ([_, version]) => ({ name, version })))
  );
}
 
function formatDependencyVersion(version: DirectoryParsedTypingVersion | "*") {
  return version === "*" ? "*" : formatTypingVersion(version);
}

export async function getAffectedPackagesFromDiff(
  allPackages: AllPackages,
  definitelyTypedPath: string,
  selection: "all" | "affected" | RegExp
): Promise<PreparePackagesResult> {
  const diffs = await gitDiff(consoleLogger.info, definitelyTypedPath);
  if (diffs.find((d) => d.file === "notNeededPackages.json")) {
    for (const deleted of getNotNeededPackages(allPackages, diffs)) {
      checkNotNeededPackage(deleted);
    }
  }
  const affected =
    selection === "all" ? { packageNames: new Set(allPackages.allTypings().map(t => t.subDirectoryPath)), dependents: [] }
      : selection === "affected" ? await getAffectedPackages(allPackages, gitDeletions(diffs), definitelyTypedPath)
      : {
          packageNames: new Set(allPackages.allTypings().filter((t) => selection.test(t.name)).map(t => t.subDirectoryPath)),
          dependents: [],
        };

  console.log(
    `Testing ${affected.packageNames.size} changed packages: ${inspect(affected.packageNames)}`
  );
  console.log(
    `Testing ${affected.dependents.length} dependent packages: ${JSON.stringify(affected.dependents)}`
  );
  return affected;
}

/**
 * 1. libraryName must exist on npm (SKIPPED and preferably/optionally have been the libraryName in just-deleted header)
 * 2. asOfVersion must be newer than `@types/name@latest` on npm
 * 3. `name@asOfVersion` must exist on npm
 */
export async function checkNotNeededPackage(unneeded: NotNeededPackage) {
  await pacote.manifest(`${unneeded.libraryName}@${unneeded.version}`, { cache: cacheDir }).catch((reason) => {
    throw reason.code === "E404"
      ? new Error(
          `The entry for ${unneeded.fullNpmName} in notNeededPackages.json has
"libraryName": "${unneeded.libraryName}", but there is no npm package with this name.
Unneeded packages have to be replaced with a package on npm.`,
          { cause: reason }
        )
      : reason.code === "ETARGET"
      ? new Error(`The specified version ${unneeded.version} of ${unneeded.libraryName} is not on npm.`, {
          cause: reason,
        })
      : reason;
  }); // eg @babel/parser
  const typings = await pacote.manifest(unneeded.fullNpmName, { cache: cacheDir }).catch((reason) => {
    throw reason.code === "E404"
      ? new Error(`Unexpected error: @types package not found for ${unneeded.fullNpmName}`, { cause: reason })
      : reason;
  }); // eg @types/babel__parser
  assert(
    semver.gt(unneeded.version, typings.version),
    `The specified version ${unneeded.version} of ${unneeded.libraryName} must be newer than the version
it is supposed to replace, ${typings.version} of ${unneeded.fullNpmName}.`
  );
}

/**
 * 1. Find all the deleted files and group by package (error on deleted files outside a package).
 * 2. Make sure that all deleted packages in notNeededPackages have no files left.
 */
export function getNotNeededPackages(allPackages: AllPackages, diffs: GitDiff[]) {
  const deletedPackages = new Set(
    diffs
      .filter((d) => d.status === "D")
      .map(
        (d) =>
          assertDefined(
            getDependencyFromFile(d.file),
            `Unexpected file deleted: ${d.file}
When removing packages, you should only delete files that are a part of removed packages.`
          ).name
      )
  );
  return mapDefined(deletedPackages, (p) => {
    const hasTyping = allPackages.hasTypingFor({ name: p, version: "*" });
    const notNeeded = allPackages.getNotNeededPackage(p);
    if (hasTyping) {
      if (notNeeded) {
        throw new Error(`Please delete all files in ${p} when adding it to notNeededPackages.json.`);
      }
      return undefined;
    } else {
      return notNeeded;
    }
  });
}
