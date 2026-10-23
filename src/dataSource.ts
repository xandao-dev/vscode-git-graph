import * as cp from 'child_process';
import * as fs from 'fs';
import { decode, encodingExists } from 'iconv-lite';
import * as path from 'path';
import * as vscode from 'vscode';
import { AskpassEnvironment, AskpassManager } from './askpass/askpassManager';
import { getConfig } from './config';
import { Logger } from './logger';
import {
	CommitOrdering,
	DateType,
	DeepWriteable,
	ErrorInfo,
	ErrorInfoExtensionPrefix,
	GitCommit,
	GitCommitDetails,
	GitCommitStash,
	GitConfigLocation,
	GitFileChange,
	GitFileStatus,
	GitPushBranchMode,
	GitRepoConfig,
	GitRepoConfigBranches,
	GitResetMode,
	GitSignature,
	GitSignatureStatus,
	GitStash,
	GitTagDetails,
	MergeActionOn,
	RebaseActionOn,
	RebaseTodoAction,
	RebaseTodoEntry,
	SquashMessageFormat,
	TagType,
	Writeable
} from './types';
import {
	GitExecutable,
	GitVersionRequirement,
	UNABLE_TO_FIND_GIT_MSG,
	UNCOMMITTED,
	abbrevCommit,
	constructIncompatibleGitVersionMessage,
	doesVersionMeetRequirement,
	getPathFromStr,
	getPathFromUri,
	openGitTerminal,
	pathWithTrailingSlash,
	realpath,
	resolveSpawnOutput,
	showErrorMessage
} from './utils';
import { Disposable } from './utils/disposable';
import { Event } from './utils/event';

const DRIVE_LETTER_PATH_REGEX = /^[a-z]:\//;
const EOL_REGEX = /\r\n|\r|\n/g;
const INVALID_BRANCH_REGEXP = /^\(.* .*\)$/;
const REMOTE_HEAD_BRANCH_REGEXP = /^remotes\/.*\/HEAD$/;
const GIT_LOG_SEPARATOR = 'XX7Nal-YARtTpjCikii9nJxER19D6diSyk-AWkPb';
const AUTOSQUASH_SUBJECT_REGEXP = /^(fixup|squash)! /;

export const enum GitConfigKey {
	DiffGuiTool = 'diff.guitool',
	DiffTool = 'diff.tool',
	RemotePushDefault = 'remote.pushdefault',
	UserEmail = 'user.email',
	UserName = 'user.name'
}

const GPG_STATUS_CODE_PARSING_DETAILS: Readonly<{ [statusCode: string]: GpgStatusCodeParsingDetails }> = {
	'GOODSIG': { status: GitSignatureStatus.GoodAndValid, uid: true },
	'BADSIG': { status: GitSignatureStatus.Bad, uid: true },
	'ERRSIG': { status: GitSignatureStatus.CannotBeChecked, uid: false },
	'EXPSIG': { status: GitSignatureStatus.GoodButExpired, uid: true },
	'EXPKEYSIG': { status: GitSignatureStatus.GoodButMadeByExpiredKey, uid: true },
	'REVKEYSIG': { status: GitSignatureStatus.GoodButMadeByRevokedKey, uid: true }
};

/**
 * Interfaces Git Graph with the Git executable to provide all Git integrations.
 */
export class DataSource extends Disposable {
	private readonly logger: Logger;
	private readonly askpassEnv: AskpassEnvironment;
	private gitExecutable!: GitExecutable | null;
	private gitExecutableSupportsGpgInfo!: boolean;
	private gitFormatCommitDetails!: string;
	private gitFormatLog!: string;
	private gitFormatStash!: string;

	/**
	 * Creates the Git Graph Data Source.
	 * @param gitExecutable The Git executable available to Git Graph at startup.
	 * @param onDidChangeGitExecutable The Event emitting the Git executable for Git Graph to use.
	 * @param logger The Git Graph Logger instance.
	 */
	constructor(gitExecutable: GitExecutable | null, onDidChangeConfiguration: Event<vscode.ConfigurationChangeEvent>, onDidChangeGitExecutable: Event<GitExecutable>, logger: Logger) {
		super();
		this.logger = logger;
		this.setGitExecutable(gitExecutable);

		const askpassManager = new AskpassManager();
		this.askpassEnv = askpassManager.getEnv();

		this.registerDisposables(
			onDidChangeConfiguration((event) => {
				if (
					event.affectsConfiguration('git-graph.date.type') ||
					event.affectsConfiguration('git-graph.dateType') ||
					event.affectsConfiguration('git-graph.repository.commits.showSignatureStatus') ||
					event.affectsConfiguration('git-graph.showSignatureStatus') ||
					event.affectsConfiguration('git-graph.repository.useMailmap') ||
					event.affectsConfiguration('git-graph.useMailmap')
				) {
					this.generateGitCommandFormats();
				}
			}),
			onDidChangeGitExecutable((gitExecutable) => {
				this.setGitExecutable(gitExecutable);
			}),
			askpassManager
		);
	}

	/**
	 * Check if the Git executable is unknown.
	 * @returns TRUE => Git executable is unknown, FALSE => Git executable is known.
	 */
	public isGitExecutableUnknown() {
		return this.gitExecutable === null;
	}

	/**
	 * Set the Git executable used by the DataSource.
	 * @param gitExecutable The Git executable.
	 */
	private setGitExecutable(gitExecutable: GitExecutable | null) {
		this.gitExecutable = gitExecutable;
		this.gitExecutableSupportsGpgInfo = gitExecutable !== null && doesVersionMeetRequirement(gitExecutable.version, GitVersionRequirement.GpgInfo);
		this.generateGitCommandFormats();
	}

	/**
	 * Generate the format strings used by various Git commands.
	 */
	private generateGitCommandFormats() {
		const config = getConfig();
		const dateType = config.dateType === DateType.Author ? '%at' : '%ct';
		const useMailmap = config.useMailmap;

		this.gitFormatCommitDetails = [
			'%H',
			'%P', // Hash & Parent Information
			useMailmap ? '%aN' : '%an',
			useMailmap ? '%aE' : '%ae',
			'%at',
			useMailmap ? '%cN' : '%cn',
			useMailmap ? '%cE' : '%ce',
			'%ct', // Author / Commit Information
			...(config.showSignatureStatus && this.gitExecutableSupportsGpgInfo ? ['%G?', '%GS', '%GK'] : ['', '', '']), // GPG Key Information
			'%B' // Body
		].join(GIT_LOG_SEPARATOR);

		this.gitFormatLog = [
			'%H',
			'%P', // Hash & Parent Information
			useMailmap ? '%aN' : '%an',
			useMailmap ? '%aE' : '%ae',
			dateType, // Author / Commit Information
			'%s' // Subject
		].join(GIT_LOG_SEPARATOR);

		this.gitFormatStash = [
			'%H',
			'%P',
			'%gD', // Hash, Parent & Selector Information
			useMailmap ? '%aN' : '%an',
			useMailmap ? '%aE' : '%ae',
			dateType, // Author / Commit Information
			'%s' // Subject
		].join(GIT_LOG_SEPARATOR);
	}

	/* Get Data Methods - Core */

	/**
	 * Get the high-level information of a repository.
	 * @param repo The path of the repository.
	 * @param showRemoteBranches Are remote branches shown.
	 * @param showStashes Are stashes shown.
	 * @param hideRemotes An array of hidden remotes.
	 * @returns The repositories information.
	 */
	public getRepoInfo(repo: string, showRemoteBranches: boolean, showStashes: boolean, hideRemotes: ReadonlyArray<string>): Promise<GitRepoInfo> {
		return Promise.all([this.getBranches(repo, showRemoteBranches, hideRemotes), this.getRemotes(repo), showStashes ? this.getStashes(repo) : Promise.resolve([])])
			.then((results) => {
				return { branches: results[0].branches, head: results[0].head, remotes: results[1], stashes: results[2], error: null };
			})
			.catch((errorMessage) => {
				return { branches: [], head: null, remotes: [], stashes: [], error: errorMessage };
			});
	}

	/**
	 * Get the commits in a repository.
	 * @param repo The path of the repository.
	 * @param branches The list of branch heads to display, or NULL (show all).
	 * @param maxCommits The maximum number of commits to return.
	 * @param showTags Are tags are shown.
	 * @param showRemoteBranches Are remote branches shown.
	 * @param includeCommitsMentionedByReflogs Should commits mentioned by reflogs being included.
	 * @param onlyFollowFirstParent Only follow the first parent of commits.
	 * @param commitOrdering The order for commits to be returned.
	 * @param remotes An array of known remotes.
	 * @param hideRemotes An array of hidden remotes.
	 * @param stashes An array of all stashes in the repository.
	 * @param simplifyByDecoration Only return commits that are referenced by a branch or tag (ignored when filtering by paths, as they can't be combined).
	 * @param pathFilter A comma separated list of paths to only return the commits that modified them, or NULL (no path filter).
	 * @param showSignatures Include the signature status of each commit (Git has to verify every signature, so this is only requested when it's displayed).
	 * @returns The commits in the repository.
	 */
	public getCommits(
		repo: string,
		branches: ReadonlyArray<string> | null,
		maxCommits: number,
		showTags: boolean,
		showRemoteBranches: boolean,
		includeCommitsMentionedByReflogs: boolean,
		onlyFollowFirstParent: boolean,
		commitOrdering: CommitOrdering,
		remotes: ReadonlyArray<string>,
		hideRemotes: ReadonlyArray<string>,
		stashes: ReadonlyArray<GitStash>,
		simplifyByDecoration: boolean,
		pathFilter: string | null,
		showSignatures: boolean
	): Promise<GitCommitData> {
		const config = getConfig();
		const paths =
			pathFilter !== null
				? pathFilter
						.split(',')
						.map((filterPath) => filterPath.trim())
						.filter((filterPath) => filterPath !== '')
				: [];
		const getLog = (simplifyMerges: boolean, includeSignatures: boolean) =>
			this.getLog(
				repo,
				branches,
				maxCommits + 1,
				showTags && config.showCommitsOnlyReferencedByTags,
				showRemoteBranches,
				includeCommitsMentionedByReflogs,
				onlyFollowFirstParent,
				commitOrdering,
				remotes,
				hideRemotes,
				stashes,
				simplifyByDecoration && paths.length === 0,
				paths,
				simplifyMerges,
				includeSignatures
			);
		return Promise.all([
			getLog(paths.length > 0, showSignatures),
			this.getRefs(repo, showRemoteBranches, config.showRemoteHeads, hideRemotes).then(
				(refData: GitRefData) => refData,
				(errorMessage: string) => errorMessage
			),
			// The commits that modified the paths, the other commits returned when filtering by paths are only included to connect them in the graph
			paths.length > 0 ? getLog(false, false).then((commits) => new Set(commits.map((commit) => commit.hash))) : null
		])
			.then(async (results) => {
				let commits: GitCommitRecord[] = results[0],
					refData: GitRefData | string = results[1],
					pathFilterMatches = results[2],
					i;
				let moreCommitsAvailable = commits.length === maxCommits + 1;
				if (moreCommitsAvailable) commits.pop();

				// It doesn't matter if getRefs() was rejected if no commits exist
				if (typeof refData === 'string') {
					// getRefs() returned an error message (string)
					if (commits.length > 0) {
						// Commits exist, throw the error
						throw refData;
					} else {
						// No commits exist, so getRefs() will always return an error. Set refData to the default value
						refData = { head: null, heads: [], tags: [], remotes: [] };
					}
				}

				if (pathFilterMatches !== null && branches === null && refData.head !== null && !commits.some((commit) => commit.hash === refData.head)) {
					// The checked-out commit didn't modify the paths, include it so that it (and any uncommitted changes) are still displayed
					const head = (await this.getLog(repo, [refData.head], 1, false, false, false, false, commitOrdering, [], [], [], false, [], false, showSignatures))[0];
					const headParents = head.parents.filter((parent) => commits.some((commit) => commit.hash === parent));
					let insertAt = 0;
					while (insertAt < commits.length && commits[insertAt].date > head.date && !headParents.includes(commits[insertAt].hash)) insertAt++;
					commits.splice(insertAt, 0, { ...head, parents: headParents });
				}

				if (refData.head !== null && config.showUncommittedChanges) {
					for (i = 0; i < commits.length; i++) {
						if (refData.head === commits[i].hash) {
							const numUncommittedChanges = await this.getUncommittedChanges(repo);
							if (numUncommittedChanges > 0) {
								commits.unshift({
									hash: UNCOMMITTED,
									parents: [refData.head],
									author: '*',
									email: '',
									date: Math.round(new Date().getTime() / 1000),
									message: 'Uncommitted Changes (' + numUncommittedChanges + ')',
									signature: null
								});
							}
							break;
						}
					}
				}

				let commitNodes: DeepWriteable<GitCommit>[] = [];
				let commitLookup: { [hash: string]: number } = {};

				for (i = 0; i < commits.length; i++) {
					commitLookup[commits[i].hash] = i;
					commitNodes.push({
						...commits[i],
						heads: [],
						tags: [],
						remotes: [],
						stash: null,
						isPathFilterMatch: pathFilterMatches === null || pathFilterMatches.has(commits[i].hash) || commits[i].hash === UNCOMMITTED
					});
				}

				/* Insert Stashes */
				let toAdd: { index: number; data: GitStash }[] = [];
				for (i = 0; i < stashes.length; i++) {
					if (typeof commitLookup[stashes[i].hash] === 'number') {
						commitNodes[commitLookup[stashes[i].hash]].stash = {
							selector: stashes[i].selector,
							baseHash: stashes[i].baseHash,
							untrackedFilesHash: stashes[i].untrackedFilesHash
						};
					} else if (typeof commitLookup[stashes[i].baseHash] === 'number') {
						toAdd.push({ index: commitLookup[stashes[i].baseHash], data: stashes[i] });
					}
				}
				toAdd.sort((a, b) => (a.index !== b.index ? a.index - b.index : b.data.date - a.data.date));
				for (i = toAdd.length - 1; i >= 0; i--) {
					let stash = toAdd[i].data;
					commitNodes.splice(toAdd[i].index, 0, {
						hash: stash.hash,
						parents: [stash.baseHash],
						author: stash.author,
						email: stash.email,
						date: stash.date,
						message: stash.message,
						heads: [],
						tags: [],
						remotes: [],
						stash: {
							selector: stash.selector,
							baseHash: stash.baseHash,
							untrackedFilesHash: stash.untrackedFilesHash
						},
						isPathFilterMatch: true,
						signature: null
					});
				}
				for (i = 0; i < commitNodes.length; i++) {
					// Correct commit lookup after stashes have been spliced in
					commitLookup[commitNodes[i].hash] = i;
				}

				/* Move references to commits that aren't displayed (because they didn't modify the paths) to their nearest displayed ancestor */
				if (pathFilterMatches !== null && commits.length > 0) {
					const annotatedTags = new Set(refData.tags.filter((tag) => tag.annotated).map((tag) => tag.name));
					const refHashes = [...refData.heads, ...(showTags ? refData.tags.filter((tag) => tag.annotated || !annotatedTags.has(tag.name)) : []), ...refData.remotes]
						.map((ref) => ref.hash)
						.filter((hash) => typeof commitLookup[hash] !== 'number');
					if (refHashes.length > 0) {
						const oldestDate = commits.reduce((date, commit) => Math.min(date, commit.date), commits[0].date);
						const ancestors = await this.getNearestAncestorsInSet(repo, unique(refHashes), commitLookup, oldestDate);
						// Point the references' commits at their ancestors in the commit lookup, so they are annotated on them below
						Object.keys(ancestors).forEach((hash) => (commitLookup[hash] = commitLookup[ancestors[hash]]));
					}
				}

				/* Annotate Heads */
				for (i = 0; i < refData.heads.length; i++) {
					if (typeof commitLookup[refData.heads[i].hash] === 'number') commitNodes[commitLookup[refData.heads[i].hash]].heads.push(refData.heads[i].name);
				}

				/* Annotate Tags */
				if (showTags) {
					for (i = 0; i < refData.tags.length; i++) {
						if (typeof commitLookup[refData.tags[i].hash] === 'number') commitNodes[commitLookup[refData.tags[i].hash]].tags.push({ name: refData.tags[i].name, annotated: refData.tags[i].annotated });
					}
				}

				/* Annotate Remotes */
				for (i = 0; i < refData.remotes.length; i++) {
					if (typeof commitLookup[refData.remotes[i].hash] === 'number') {
						let name = refData.remotes[i].name;
						let remote = remotes.find((remote) => name.startsWith(remote + '/'));
						commitNodes[commitLookup[refData.remotes[i].hash]].remotes.push({ name: name, remote: remote ? remote : null });
					}
				}

				return {
					commits: commitNodes,
					head: refData.head,
					tags: unique(refData.tags.map((tag) => tag.name)),
					moreCommitsAvailable: moreCommitsAvailable,
					error: null
				};
			})
			.catch((errorMessage) => {
				return { commits: [], head: null, tags: [], moreCommitsAvailable: false, error: errorMessage };
			});
	}

	/**
	 * Get various Git config variables for a repository that are consumed by the Git Graph View.
	 * @param repo The path of the repository.
	 * @param remotes An array of known remotes.
	 * @returns The config data.
	 */
	public getConfig(repo: string, remotes: ReadonlyArray<string>): Promise<GitRepoConfigData> {
		return Promise.all([this.getConfigList(repo), this.getConfigList(repo, GitConfigLocation.Local), this.getConfigList(repo, GitConfigLocation.Global)])
			.then((results) => {
				const consolidatedConfigs = results[0],
					localConfigs = results[1],
					globalConfigs = results[2];

				const branches: GitRepoConfigBranches = {};
				Object.keys(localConfigs).forEach((key) => {
					if (key.startsWith('branch.')) {
						if (key.endsWith('.remote')) {
							const branchName = key.substring(7, key.length - 7);
							branches[branchName] = {
								pushRemote: typeof branches[branchName] !== 'undefined' ? branches[branchName].pushRemote : null,
								remote: localConfigs[key]
							};
						} else if (key.endsWith('.pushremote')) {
							const branchName = key.substring(7, key.length - 11);
							branches[branchName] = {
								pushRemote: localConfigs[key],
								remote: typeof branches[branchName] !== 'undefined' ? branches[branchName].remote : null
							};
						}
					}
				});

				return {
					config: {
						branches: branches,
						diffTool: getConfigValue(consolidatedConfigs, GitConfigKey.DiffTool),
						guiDiffTool: getConfigValue(consolidatedConfigs, GitConfigKey.DiffGuiTool),
						pushDefault: getConfigValue(consolidatedConfigs, GitConfigKey.RemotePushDefault),
						remotes: remotes.map((remote) => ({
							name: remote,
							url: getConfigValue(localConfigs, 'remote.' + remote + '.url'),
							pushUrl: getConfigValue(localConfigs, 'remote.' + remote + '.pushurl')
						})),
						user: {
							name: {
								local: getConfigValue(localConfigs, GitConfigKey.UserName),
								global: getConfigValue(globalConfigs, GitConfigKey.UserName)
							},
							email: {
								local: getConfigValue(localConfigs, GitConfigKey.UserEmail),
								global: getConfigValue(globalConfigs, GitConfigKey.UserEmail)
							}
						}
					},
					error: null
				};
			})
			.catch((errorMessage) => {
				return { config: null, error: errorMessage };
			});
	}

	/* Get Data Methods - Commit Details View */

	/**
	 * Get the commit details for the Commit Details View.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the commit open in the Commit Details View.
	 * @param hasParents Does the commit have parents
	 * @param parentIndex The (1-based) index of the parent that the commit's changes are diffed against.
	 * @returns The commit details.
	 */
	public getCommitDetails(repo: string, commitHash: string, hasParents: boolean, parentIndex: number): Promise<GitCommitDetailsData> {
		const fromCommit = commitHash + (hasParents ? '^' + parentIndex : '');
		return Promise.all([this.getCommitDetailsBase(repo, commitHash), this.getDiffNameStatus(repo, fromCommit, commitHash), this.getDiffNumStat(repo, fromCommit, commitHash)])
			.then((results) => {
				results[0].fileChanges = generateFileChanges(results[1], results[2], null);
				return { commitDetails: results[0], error: null };
			})
			.catch((errorMessage) => {
				return { commitDetails: null, error: errorMessage };
			});
	}

	/**
	 * Get the stash details for the Commit Details View.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the stash commit open in the Commit Details View.
	 * @param stash The stash.
	 * @param parentIndex The (1-based) index of the parent that the stash's changes are diffed against.
	 * @returns The stash details.
	 */
	public getStashDetails(repo: string, commitHash: string, stash: GitCommitStash, parentIndex: number): Promise<GitCommitDetailsData> {
		const fromCommit = commitHash + '^' + parentIndex;
		return Promise.all([
			this.getCommitDetailsBase(repo, commitHash),
			this.getDiffNameStatus(repo, fromCommit, commitHash),
			this.getDiffNumStat(repo, fromCommit, commitHash),
			stash.untrackedFilesHash !== null ? this.getDiffNameStatus(repo, stash.untrackedFilesHash, stash.untrackedFilesHash) : Promise.resolve([]),
			stash.untrackedFilesHash !== null ? this.getDiffNumStat(repo, stash.untrackedFilesHash, stash.untrackedFilesHash) : Promise.resolve([])
		])
			.then((results) => {
				results[0].fileChanges = generateFileChanges(results[1], results[2], null);
				if (stash.untrackedFilesHash !== null) {
					generateFileChanges(results[3], results[4], null).forEach((fileChange) => {
						if (fileChange.type === GitFileStatus.Added) {
							fileChange.type = GitFileStatus.Untracked;
							results[0].fileChanges.push(fileChange);
						}
					});
				}
				return { commitDetails: results[0], error: null };
			})
			.catch((errorMessage) => {
				return { commitDetails: null, error: errorMessage };
			});
	}

	/**
	 * Get the uncommitted details for the Commit Details View.
	 * @param repo The path of the repository.
	 * @returns The uncommitted details.
	 */
	public getUncommittedDetails(repo: string): Promise<GitCommitDetailsData> {
		return Promise.all([this.getDiffNameStatus(repo, 'HEAD', ''), this.getDiffNumStat(repo, 'HEAD', ''), this.getStatus(repo)])
			.then((results) => {
				return {
					commitDetails: {
						hash: UNCOMMITTED,
						parents: [],
						author: '',
						authorEmail: '',
						authorDate: 0,
						committer: '',
						committerEmail: '',
						committerDate: 0,
						signature: null,
						body: '',
						fileChanges: generateFileChanges(results[0], results[1], results[2])
					},
					error: null
				};
			})
			.catch((errorMessage) => {
				return { commitDetails: null, error: errorMessage };
			});
	}

	/**
	 * Get the comparison details for the Commit Comparison View.
	 * @param repo The path of the repository.
	 * @param fromHash The commit hash the comparison is from.
	 * @param toHash The commit hash the comparison is to.
	 * @returns The comparison details.
	 */
	public getCommitComparison(repo: string, fromHash: string, toHash: string): Promise<GitCommitComparisonData> {
		return Promise.all([
			this.getDiffNameStatus(repo, fromHash, toHash === UNCOMMITTED ? '' : toHash),
			this.getDiffNumStat(repo, fromHash, toHash === UNCOMMITTED ? '' : toHash),
			toHash === UNCOMMITTED ? this.getStatus(repo) : Promise.resolve(null)
		])
			.then((results) => {
				return {
					fileChanges: generateFileChanges(results[0], results[1], results[2]),
					error: null
				};
			})
			.catch((errorMessage) => {
				return { fileChanges: [], error: errorMessage };
			});
	}

	/**
	 * Get the contents of a file at a specific revision.
	 * @param repo The path of the repository.
	 * @param commitHash The commit hash specifying the revision of the file.
	 * @param filePath The path of the file relative to the repositories root.
	 * @returns The file contents.
	 */
	public getCommitFile(repo: string, commitHash: string, filePath: string) {
		return this._spawnGit(['show', commitHash + ':' + filePath], repo, (stdout) => {
			const encoding = getConfig(repo).fileEncoding;
			return decode(stdout, encodingExists(encoding) ? encoding : 'utf8');
		});
	}

	/* Get Data Methods - General */

	/**
	 * Get the subject of a commit.
	 * @param repo The path of the repository.
	 * @param commitHash The commit hash.
	 * @returns The subject string, or NULL if an error occurred.
	 */
	public getCommitSubject(repo: string, commitHash: string): Promise<string | null> {
		return this.spawnGit(['-c', 'log.showSignature=false', 'log', '--format=%s', '-n', '1', commitHash, '--'], repo, (stdout) => {
			return stdout.trim().replace(/\s+/g, ' ');
		}).then(
			(subject) => subject,
			() => null
		);
	}

	/**
	 * Get the full message (subject & body) of a commit.
	 * @param repo The path of the repository.
	 * @param commitHash The commit hash.
	 * @returns The commit message.
	 */
	public getCommitMessage(repo: string, commitHash: string): Promise<GitCommitMessageData> {
		return this.spawnGit(['-c', 'log.showSignature=false', 'show', '--quiet', '--format=%B', commitHash, '--'], repo, (stdout) => {
			return removeTrailingBlankLines(stdout.split(EOL_REGEX)).join('\n');
		}).then(
			(message) => ({ message: message, error: null }),
			(errorMessage) => ({ message: null, error: errorMessage })
		);
	}

	/**
	 * Get the URL of a repositories remote.
	 * @param repo The path of the repository.
	 * @param remote The name of the remote.
	 * @returns The URL, or NULL if an error occurred.
	 */
	public getRemoteUrl(repo: string, remote: string): Promise<string | null> {
		return this.spawnGit(['config', '--get', 'remote.' + remote + '.url'], repo, (stdout) => {
			return stdout.split(EOL_REGEX)[0];
		}).then(
			(url) => url,
			() => null
		);
	}

	/**
	 * Check to see if a file has been renamed between a commit and the working tree, and return the new file path.
	 * @param repo The path of the repository.
	 * @param commitHash The commit hash where `oldFilePath` is known to have existed.
	 * @param oldFilePath The file path that may have been renamed.
	 * @returns The new renamed file path, or NULL if either: the file wasn't renamed or the Git command failed to execute.
	 */
	public getNewPathOfRenamedFile(repo: string, commitHash: string, oldFilePath: string) {
		return this.getDiffNameStatus(repo, commitHash, '', 'R')
			.then((renamed) => {
				const renamedRecordForFile = renamed.find((record) => record.oldFilePath === oldFilePath);
				return renamedRecordForFile ? renamedRecordForFile.newFilePath : null;
			})
			.catch(() => null);
	}

	/**
	 * Get the details of a tag.
	 * @param repo The path of the repository.
	 * @param tagName The name of the tag.
	 * @returns The tag details.
	 */
	public getTagDetails(repo: string, tagName: string): Promise<GitTagDetailsData> {
		if (this.gitExecutable !== null && !doesVersionMeetRequirement(this.gitExecutable.version, GitVersionRequirement.TagDetails)) {
			return Promise.resolve({ details: null, error: constructIncompatibleGitVersionMessage(this.gitExecutable, GitVersionRequirement.TagDetails, 'retrieving Tag Details') });
		}

		const ref = 'refs/tags/' + tagName;
		return this.spawnGit(
			['for-each-ref', ref, '--format=' + ['%(objectname)', '%(taggername)', '%(taggeremail)', '%(taggerdate:unix)', '%(contents:signature)', '%(contents)'].join(GIT_LOG_SEPARATOR)],
			repo,
			(stdout) => {
				const data = stdout.split(GIT_LOG_SEPARATOR);
				return {
					hash: data[0],
					taggerName: data[1],
					taggerEmail: data[2].substring(data[2].startsWith('<') ? 1 : 0, data[2].length - (data[2].endsWith('>') ? 1 : 0)),
					taggerDate: parseInt(data[3]),
					message: removeTrailingBlankLines(data.slice(5).join(GIT_LOG_SEPARATOR).replace(data[4], '').split(EOL_REGEX)).join('\n'),
					signed: data[4] !== ''
				};
			}
		)
			.then(async (tag) => ({
				details: {
					hash: tag.hash,
					taggerName: tag.taggerName,
					taggerEmail: tag.taggerEmail,
					taggerDate: tag.taggerDate,
					message: tag.message,
					signature: tag.signed ? await this.getTagSignature(repo, ref) : null
				},
				error: null
			}))
			.catch((errorMessage) => ({
				details: null,
				error: errorMessage
			}));
	}

	/**
	 * Get the submodules of a repository.
	 * @param repo The path of the repository.
	 * @returns An array of the paths of the submodules.
	 */
	public getSubmodules(repo: string) {
		return new Promise<string[]>((resolve) => {
			fs.readFile(path.join(repo, '.gitmodules'), { encoding: 'utf8' }, async (err, data) => {
				let submodules: string[] = [];
				if (!err) {
					let lines = data.split(EOL_REGEX),
						inSubmoduleSection = false,
						match;
					const section = /^\s*\[.*\]\s*$/,
						submodule = /^\s*\[submodule "([^"]+)"\]\s*$/,
						pathProp = /^\s*path\s+=\s+(.*)$/;

					for (let i = 0; i < lines.length; i++) {
						if (lines[i].match(section) !== null) {
							inSubmoduleSection = lines[i].match(submodule) !== null;
							continue;
						}

						if (inSubmoduleSection && (match = lines[i].match(pathProp)) !== null) {
							let root = await this.repoRoot(getPathFromUri(vscode.Uri.file(path.join(repo, getPathFromStr(match[1])))));
							if (root !== null && !submodules.includes(root)) {
								submodules.push(root);
							}
						}
					}
				}
				resolve(submodules);
			});
		});
	}

	/* Repository Info Methods */

	/**
	 * Check if there are any staged changes in the repository.
	 * @param repo The path of the repository.
	 * @returns TRUE => Staged Changes, FALSE => No Staged Changes.
	 */
	private areStagedChanges(repo: string) {
		return this.spawnGit(['diff-index', 'HEAD'], repo, (stdout) => stdout !== '').then(
			(changes) => changes,
			() => false
		);
	}

	/**
	 * Get the root of the repository containing the specified path.
	 * @param pathOfPotentialRepo The path that is potentially a repository (or is contained within a repository).
	 * @returns STRING => The root of the repository, NULL => `pathOfPotentialRepo` is not in a repository.
	 */
	public repoRoot(pathOfPotentialRepo: string) {
		return this.spawnGit(['rev-parse', '--show-toplevel'], pathOfPotentialRepo, (stdout) => getPathFromUri(vscode.Uri.file(path.normalize(stdout.trim()))))
			.then(async (pathReturnedByGit) => {
				if (process.platform === 'win32') {
					// On Windows Mapped Network Drives with Git >= 2.25.0, `git rev-parse --show-toplevel` returns the UNC Path for the Mapped Network Drive, instead of the Drive Letter.
					// Attempt to replace the UNC Path with the Drive Letter.
					let driveLetterPathMatch: RegExpMatchArray | null;
					if ((driveLetterPathMatch = pathOfPotentialRepo.match(DRIVE_LETTER_PATH_REGEX)) && !pathReturnedByGit.match(DRIVE_LETTER_PATH_REGEX)) {
						const realPathForDriveLetter = pathWithTrailingSlash(await realpath(driveLetterPathMatch[0], true));
						if (realPathForDriveLetter !== driveLetterPathMatch[0] && pathReturnedByGit.startsWith(realPathForDriveLetter)) {
							pathReturnedByGit = driveLetterPathMatch[0] + pathReturnedByGit.substring(realPathForDriveLetter.length);
						}
					}
				}
				let path = pathOfPotentialRepo;
				let first = path.indexOf('/');
				while (true) {
					if (pathReturnedByGit === path || pathReturnedByGit === (await realpath(path))) return path;
					let next = path.lastIndexOf('/');
					if (first !== next && next > -1) {
						path = path.substring(0, next);
					} else {
						return pathReturnedByGit;
					}
				}
			})
			.catch(() => null); // null => path is not in a repo
	}

	/* Git Action Methods - Remotes */

	/**
	 * Add a new remote to a repository.
	 * @param repo The path of the repository.
	 * @param name The name of the remote.
	 * @param url The URL of the remote.
	 * @param pushUrl The Push URL of the remote.
	 * @param fetch Fetch the remote after it is added.
	 * @returns The ErrorInfo from the executed command.
	 */
	public async addRemote(repo: string, name: string, url: string, pushUrl: string | null, fetch: boolean) {
		let status = await this.runGitCommand(['remote', 'add', name, url], repo);
		if (status !== null) return status;

		if (pushUrl !== null) {
			status = await this.runGitCommand(['remote', 'set-url', name, '--push', pushUrl], repo);
			if (status !== null) return status;
		}

		return fetch ? this.fetch(repo, name, false, false) : null;
	}

	/**
	 * Delete an existing remote from a repository.
	 * @param repo The path of the repository.
	 * @param name The name of the remote.
	 * @returns The ErrorInfo from the executed command.
	 */
	public deleteRemote(repo: string, name: string) {
		return this.runGitCommand(['remote', 'remove', name], repo);
	}

	/**
	 * Edit an existing remote of a repository.
	 * @param repo The path of the repository.
	 * @param nameOld The old name of the remote.
	 * @param nameNew The new name of the remote.
	 * @param urlOld The old URL of the remote.
	 * @param urlNew The new URL of the remote.
	 * @param pushUrlOld The old Push URL of the remote.
	 * @param pushUrlNew The new Push URL of the remote.
	 * @returns The ErrorInfo from the executed command.
	 */
	public async editRemote(repo: string, nameOld: string, nameNew: string, urlOld: string | null, urlNew: string | null, pushUrlOld: string | null, pushUrlNew: string | null) {
		if (nameOld !== nameNew) {
			let status = await this.runGitCommand(['remote', 'rename', nameOld, nameNew], repo);
			if (status !== null) return status;
		}

		if (urlOld !== urlNew) {
			let args = ['remote', 'set-url', nameNew];
			if (urlNew === null) args.push('--delete', urlOld!);
			else if (urlOld === null) args.push('--add', urlNew);
			else args.push(urlNew, urlOld);

			let status = await this.runGitCommand(args, repo);
			if (status !== null) return status;
		}

		if (pushUrlOld !== pushUrlNew) {
			let args = ['remote', 'set-url', '--push', nameNew];
			if (pushUrlNew === null) args.push('--delete', pushUrlOld!);
			else if (pushUrlOld === null) args.push('--add', pushUrlNew);
			else args.push(pushUrlNew, pushUrlOld);

			let status = await this.runGitCommand(args, repo);
			if (status !== null) return status;
		}

		return null;
	}

	/**
	 * Prune an existing remote of a repository.
	 * @param repo The path of the repository.
	 * @param name The name of the remote.
	 * @returns The ErrorInfo from the executed command.
	 */
	public pruneRemote(repo: string, name: string) {
		return this.runGitCommand(['remote', 'prune', name], repo);
	}

	/* Git Action Methods - Tags */

	/**
	 * Add a new tag to a commit.
	 * @param repo The path of the repository.
	 * @param tagName The name of the tag.
	 * @param commitHash The hash of the commit the tag should be added to.
	 * @param type Is the tag annotated or lightweight.
	 * @param message The message of the tag (if it is an annotated tag).
	 * @param force Force add the tag, replacing an existing tag with the same name (if it exists).
	 * @returns The ErrorInfo from the executed command.
	 */
	public addTag(repo: string, tagName: string, commitHash: string, type: TagType, message: string, force: boolean) {
		const args = ['tag'];
		if (force) {
			args.push('-f');
		}
		if (type === TagType.Lightweight) {
			args.push(tagName);
		} else {
			args.push(getConfig().signTags ? '-s' : '-a', tagName, '-m', message);
		}
		args.push(commitHash);
		return this.runGitCommand(args, repo);
	}

	/**
	 * Delete an existing tag from a repository.
	 * @param repo The path of the repository.
	 * @param tagName The name of the tag.
	 * @param deleteOnRemote The name of the remote to delete the tag on, or NULL.
	 * @returns The ErrorInfo from the executed command.
	 */
	public async deleteTag(repo: string, tagName: string, deleteOnRemote: string | null) {
		if (deleteOnRemote !== null) {
			let status = await this.runGitCommand(['push', deleteOnRemote, '--delete', tagName], repo);
			if (status !== null) return status;
		}
		return this.runGitCommand(['tag', '-d', tagName], repo);
	}

	/* Git Action Methods - Remote Sync */

	/**
	 * Fetch from the repositories remote(s).
	 * @param repo The path of the repository.
	 * @param remote The remote to fetch, or NULL (fetch all remotes).
	 * @param prune Is pruning enabled.
	 * @param pruneTags Should tags be pruned.
	 * @returns The ErrorInfo from the executed command.
	 */
	public fetch(repo: string, remote: string | null, prune: boolean, pruneTags: boolean) {
		let args = ['fetch', remote === null ? '--all' : remote];

		if (prune) {
			args.push('--prune');
		}
		if (pruneTags) {
			if (!prune) {
				return Promise.resolve('In order to Prune Tags, pruning must also be enabled when fetching from ' + (remote !== null ? 'a remote' : 'remote(s)') + '.');
			} else if (this.gitExecutable !== null && !doesVersionMeetRequirement(this.gitExecutable.version, GitVersionRequirement.FetchAndPruneTags)) {
				return Promise.resolve(constructIncompatibleGitVersionMessage(this.gitExecutable, GitVersionRequirement.FetchAndPruneTags, 'pruning tags when fetching'));
			}
			args.push('--prune-tags');
		}

		return this.runGitCommand(args, repo);
	}

	/**
	 * Push a branch to a remote.
	 * @param repo The path of the repository.
	 * @param branchName The name of the branch to push.
	 * @param remote The remote to push the branch to.
	 * @param setUpstream Set the branches upstream.
	 * @param mode The mode of the push.
	 * @param noVerify Is `--no-verify` enabled.
	 * @returns The ErrorInfo from the executed command.
	 */
	public pushBranch(repo: string, branchName: string, remote: string, setUpstream: boolean, mode: GitPushBranchMode, noVerify: boolean) {
		let args = ['push'];
		args.push(remote, branchName);
		if (setUpstream) args.push('--set-upstream');
		if (mode !== GitPushBranchMode.Normal) args.push('--' + mode);
		if (noVerify) args.push('--no-verify');

		return this.runGitCommand(args, repo);
	}

	/**
	 * Push a branch to multiple remotes.
	 * @param repo The path of the repository.
	 * @param branchName The name of the branch to push.
	 * @param remotes The remotes to push the branch to.
	 * @param setUpstream Set the branches upstream.
	 * @param mode The mode of the push.
	 * @param noVerify Is `--no-verify` enabled.
	 * @returns The ErrorInfo's from the executed commands.
	 */
	public async pushBranchToMultipleRemotes(repo: string, branchName: string, remotes: string[], setUpstream: boolean, mode: GitPushBranchMode, noVerify: boolean): Promise<ErrorInfo[]> {
		if (remotes.length === 0) {
			return ['No remote(s) were specified to push the branch ' + branchName + ' to.'];
		}

		const results: ErrorInfo[] = [];
		for (let i = 0; i < remotes.length; i++) {
			const result = await this.pushBranch(repo, branchName, remotes[i], setUpstream, mode, noVerify);
			results.push(result);
			if (result !== null) break;
		}
		return results;
	}

	/**
	 * Push a tag to remote(s).
	 * @param repo The path of the repository.
	 * @param tagName The name of the tag to push.
	 * @param remotes The remote(s) to push the tag to.
	 * @param commitHash The commit hash the tag is on.
	 * @param skipRemoteCheck Skip checking that the tag is on each of the `remotes`.
	 * @returns The ErrorInfo's from the executed commands.
	 */
	public async pushTag(repo: string, tagName: string, remotes: string[], commitHash: string, skipRemoteCheck: boolean): Promise<ErrorInfo[]> {
		if (remotes.length === 0) {
			return ['No remote(s) were specified to push the tag ' + tagName + ' to.'];
		}

		if (!skipRemoteCheck) {
			const remotesContainingCommit = await this.getRemotesContainingCommit(repo, commitHash, remotes).catch(() => remotes);
			const remotesNotContainingCommit = remotes.filter((remote) => !remotesContainingCommit.includes(remote));
			if (remotesNotContainingCommit.length > 0) {
				return [ErrorInfoExtensionPrefix.PushTagCommitNotOnRemote + JSON.stringify(remotesNotContainingCommit)];
			}
		}

		const results: ErrorInfo[] = [];
		for (let i = 0; i < remotes.length; i++) {
			const result = await this.runGitCommand(['push', remotes[i], tagName], repo);
			results.push(result);
			if (result !== null) break;
		}
		return results;
	}

	/* Git Action Methods - Branches */

	/**
	 * Checkout a branch in a repository.
	 * @param repo The path of the repository.
	 * @param branchName The name of the branch to checkout.
	 * @param remoteBranch The name of the remote branch to check out (if not NULL).
	 * @returns The ErrorInfo from the executed command.
	 */
	public checkoutBranch(repo: string, branchName: string, remoteBranch: string | null) {
		let args = ['checkout'];
		if (remoteBranch === null) args.push(branchName);
		else args.push('-b', branchName, remoteBranch);

		return this.runGitCommand(args, repo);
	}

	/**
	 * Create a branch at a commit.
	 * @param repo The path of the repository.
	 * @param branchName The name of the branch.
	 * @param commitHash The hash of the commit the branch should be created at.
	 * @param checkout Check out the branch after it is created.
	 * @param force Force create the branch, replacing an existing branch with the same name (if it exists).
	 * @returns The ErrorInfo's from the executed command(s).
	 */
	public async createBranch(repo: string, branchName: string, commitHash: string, checkout: boolean, force: boolean) {
		const args = [];
		if (checkout && !force) {
			args.push('checkout', '-b');
		} else {
			args.push('branch');
			if (force) {
				args.push('-f');
			}
		}
		args.push(branchName, commitHash);

		const statuses = [await this.runGitCommand(args, repo)];
		if (statuses[0] === null && checkout && force) {
			statuses.push(await this.checkoutBranch(repo, branchName, null));
		}
		return statuses;
	}

	/**
	 * Delete a branch in a repository.
	 * @param repo The path of the repository.
	 * @param branchName The name of the branch.
	 * @param force Should force the branch to be deleted (even if not merged).
	 * @returns The ErrorInfo from the executed command.
	 */
	public deleteBranch(repo: string, branchName: string, force: boolean) {
		return this.runGitCommand(['branch', force ? '-D' : '-d', branchName], repo);
	}

	/**
	 * Delete a remote branch in a repository.
	 * @param repo The path of the repository.
	 * @param branchName The name of the branch.
	 * @param remote The name of the remote to delete the branch on.
	 * @returns The ErrorInfo from the executed command.
	 */
	public async deleteRemoteBranch(repo: string, branchName: string, remote: string) {
		let remoteStatus = await this.runGitCommand(['push', remote, '--delete', branchName], repo);
		if (remoteStatus !== null && new RegExp('remote ref does not exist', 'i').test(remoteStatus)) {
			let trackingBranchStatus = await this.runGitCommand(['branch', '-d', '-r', remote + '/' + branchName], repo);
			return trackingBranchStatus === null ? null : 'Branch does not exist on the remote, deleting the remote tracking branch ' + remote + '/' + branchName + '.\n' + trackingBranchStatus;
		}
		return remoteStatus;
	}

	/**
	 * Fetch a remote branch into a local branch.
	 * @param repo The path of the repository.
	 * @param remote The name of the remote containing the remote branch.
	 * @param remoteBranch The name of the remote branch.
	 * @param localBranch The name of the local branch.
	 * @param force Force fetch the remote branch.
	 * @returns The ErrorInfo from the executed command.
	 */
	public fetchIntoLocalBranch(repo: string, remote: string, remoteBranch: string, localBranch: string, force: boolean) {
		const args = ['fetch'];
		if (force) {
			args.push('-f');
		}
		args.push(remote, remoteBranch + ':' + localBranch);
		return this.runGitCommand(args, repo);
	}

	/**
	 * Pull a remote branch into the current branch.
	 * @param repo The path of the repository.
	 * @param branchName The name of the remote branch.
	 * @param remote The name of the remote containing the remote branch.
	 * @param createNewCommit Is `--no-ff` enabled if a merge is required.
	 * @param squash Is `--squash` enabled if a merge is required.
	 * @param noVerify Is `--no-verify` enabled when committing the squashed changes.
	 * @returns The ErrorInfo from the executed command.
	 */
	public pullBranch(repo: string, branchName: string, remote: string, createNewCommit: boolean, squash: boolean, noVerify: boolean) {
		const args = ['pull', remote, branchName],
			config = getConfig();
		if (squash) {
			args.push('--squash');
		} else if (createNewCommit) {
			args.push('--no-ff');
		}
		if (config.signCommits) {
			args.push('-S');
		}
		return this.runGitCommand(args, repo).then((pullStatus) => {
			return pullStatus === null && squash
				? this.commitSquashIfStagedChangesExist(repo, remote + '/' + branchName, MergeActionOn.Branch, config.squashPullMessageFormat, config.signCommits, noVerify)
				: pullStatus;
		});
	}

	/**
	 * Rename a branch in a repository.
	 * @param repo The path of the repository.
	 * @param oldName The old name of the branch.
	 * @param newName The new name of the branch.
	 * @returns The ErrorInfo from the executed command.
	 */
	public renameBranch(repo: string, oldName: string, newName: string) {
		return this.runGitCommand(['branch', '-m', oldName, newName], repo);
	}

	/* Git Action Methods - Branches & Commits */

	/**
	 * Merge a branch or commit into the current branch.
	 * @param repo The path of the repository.
	 * @param obj The object to be merged into the current branch.
	 * @param actionOn Is the merge on a branch, remote-tracking branch or commit.
	 * @param createNewCommit Is `--no-ff` enabled.
	 * @param allowUnrelatedHistories Is `--allow-unrelated-histories` enabled.
	 * @param squash Is `--squash` enabled.
	 * @param noVerify Is `--no-verify` enabled when committing the squashed changes.
	 * @param noCommit Is `--no-commit` enabled.
	 * @returns The ErrorInfo from the executed command.
	 */
	public merge(repo: string, obj: string, actionOn: MergeActionOn, createNewCommit: boolean, allowUnrelatedHistories: boolean, squash: boolean, noVerify: boolean, noCommit: boolean) {
		const args = ['merge', obj],
			config = getConfig();
		if (squash) {
			args.push('--squash');
		} else if (createNewCommit) {
			args.push('--no-ff');
		}
		if (noCommit) {
			args.push('--no-commit');
		}
		if (config.signCommits) {
			args.push('-S');
		}
		if (allowUnrelatedHistories) {
			args.push('--allow-unrelated-histories');
		}
		return this.runGitCommand(args, repo).then((mergeStatus) => {
			return mergeStatus === null && squash && !noCommit ? this.commitSquashIfStagedChangesExist(repo, obj, actionOn, config.squashMergeMessageFormat, config.signCommits, noVerify) : mergeStatus;
		});
	}

	/**
	 * Rebase the current branch on a branch or commit.
	 * @param repo The path of the repository.
	 * @param obj The object the current branch will be rebased onto.
	 * @param actionOn Is the rebase on a branch or commit.
	 * @param ignoreDate Is `--ignore-date` enabled.
	 * @param interactive Should the rebase be performed interactively.
	 * @param autosquash Is `--autosquash` enabled (only applicable to an interactive rebase).
	 * @returns The ErrorInfo from the executed command.
	 */
	public rebase(repo: string, obj: string, actionOn: RebaseActionOn, ignoreDate: boolean, interactive: boolean, autosquash: boolean) {
		if (interactive) {
			return this.openGitTerminal(
				repo,
				'rebase --interactive ' + (autosquash ? '--autosquash ' : '') + (getConfig().signCommits ? '-S ' : '') + (actionOn === RebaseActionOn.Branch ? obj.replace(/'/g, '"\'"') : obj),
				'Rebase on "' + (actionOn === RebaseActionOn.Branch ? obj : abbrevCommit(obj)) + '"'
			);
		} else {
			const args = ['rebase', obj];
			if (ignoreDate) {
				args.push('--ignore-date');
			}
			if (getConfig().signCommits) {
				args.push('-S');
			}
			return this.runGitCommand(args, repo);
		}
	}

	/**
	 * Get the todo list of an interactive rebase of the current branch on a branch or commit, so it can be edited in the Git Graph View.
	 * @param repo The path of the repository.
	 * @param obj The object the current branch will be rebased onto.
	 * @param autosquash Is `--autosquash` enabled (moving each "fixup!" / "squash!" commit after the commit it targets).
	 * @returns The todo list entries (ordered from oldest to newest).
	 */
	public async getRebaseTodoList(repo: string, obj: string, autosquash: boolean): Promise<GitRebaseTodoListData> {
		const data = await this.getRebaseCommits(repo, obj);
		if (data.commits === null) {
			return { entries: null, error: data.error };
		}
		const entries = data.commits.map((commit) => ({ hash: commit.hash, action: RebaseTodoAction.Pick, message: commit.message }));
		return { entries: autosquash ? rearrangeAutosquashEntries(entries) : entries, error: null };
	}

	/**
	 * Rebase the current branch on a branch or commit, using a todo list edited in the Git Graph View. The interactive rebase is run without
	 * a terminal: the todo list generated by Git is replaced with the edited one, and the commit message editor is never opened (squashed
	 * commits are applied as fixups, and the message of a reworded or squashed commit is set by amending it with an "exec" entry).
	 * @param repo The path of the repository.
	 * @param obj The object the current branch will be rebased onto.
	 * @param entries The edited todo list entries, in the order they will be applied.
	 * @returns The ErrorInfo from the executed command.
	 */
	public async rebaseWithTodo(repo: string, obj: string, entries: ReadonlyArray<RebaseTodoEntry>): Promise<ErrorInfo> {
		const data = await this.getRebaseCommits(repo, obj);
		if (data.commits === null) return data.error;

		// Check that the todo list contains each commit being rebased exactly once, so no commit is lost (e.g. if the branch changed after the todo list was loaded)
		const hashes = new Set(entries.map((entry) => entry.hash));
		if (entries.length !== data.commits.length || hashes.size !== entries.length || data.commits.some((commit) => !hashes.has(commit.hash))) {
			return 'The commits being rebased have changed since the todo list was loaded.';
		}

		const signCommits = getConfig().signCommits;
		const todo: string[] = [];
		let groupMessages: string[] | null = null,
			amendGroup = false;
		try {
			for (const entry of entries) {
				switch (entry.action) {
					case RebaseTodoAction.Pick:
					case RebaseTodoAction.Reword:
					case RebaseTodoAction.Edit:
						if (entry.action === RebaseTodoAction.Reword && entry.message.trim() === '') {
							return 'The message of reworded commit ' + abbrevCommit(entry.hash) + ' is empty.';
						}
						if (amendGroup) todo.push(await this.getRebaseTodoAmendEntry(repo, groupMessages!, signCommits));
						todo.push((entry.action === RebaseTodoAction.Edit ? 'edit ' : 'pick ') + entry.hash);
						groupMessages = [entry.message.trim()];
						amendGroup = entry.action === RebaseTodoAction.Reword;
						break;
					case RebaseTodoAction.Squash:
					case RebaseTodoAction.Fixup:
						if (groupMessages === null) {
							return 'Commit ' + abbrevCommit(entry.hash) + " can't be squashed, as no commit is picked before it.";
						}
						todo.push('fixup ' + entry.hash);
						if (entry.action === RebaseTodoAction.Squash) {
							groupMessages.push(entry.message.trim());
							amendGroup = true;
						}
						break;
					case RebaseTodoAction.Drop:
						todo.push('drop ' + entry.hash);
						break;
					default:
						return 'Unknown rebase todo action "' + entry.action + '".';
				}
			}
			if (amendGroup) todo.push(await this.getRebaseTodoAmendEntry(repo, groupMessages!, signCommits));
			if (todo.length === 0) todo.push('noop'); // An empty todo list would abort the rebase

			// Git runs the sequence editor with the path of its todo list appended, so this replaces it with the edited todo list
			const args = ['-c', 'sequence.editor=git cat-file blob ' + (await this.writeBlob(repo, todo.join('\n') + '\n')) + ' >', 'rebase', '--interactive'];
			if (signCommits) {
				args.push('-S');
			}
			args.push(obj);
			return await this.runGitCommand(args, repo);
		} catch (errorMessage) {
			return <ErrorInfo>errorMessage;
		}
	}

	/* Git Action Methods - Branches & Tags */

	/**
	 * Create an archive of a repository at a specific reference, and save to disk.
	 * @param repo The path of the repository.
	 * @param ref The reference of the revision to archive.
	 * @param outputFilePath The file path that the archive should be saved to.
	 * @param type The type of archive.
	 * @returns The ErrorInfo from the executed command.
	 */
	public archive(repo: string, ref: string, outputFilePath: string, type: 'tar' | 'zip') {
		return this.runGitCommand(['archive', '--format=' + type, '-o', outputFilePath, ref], repo);
	}

	/* Git Action Methods - Commits */

	/**
	 * Checkout a commit in a repository.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the commit to check out.
	 * @returns The ErrorInfo from the executed command.
	 */
	public checkoutCommit(repo: string, commitHash: string) {
		return this.runGitCommand(['checkout', commitHash], repo);
	}

	/**
	 * Cherrypick a commit in a repository.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the commit to be cherry picked.
	 * @param parentIndex The parent index if the commit is a merge.
	 * @param recordOrigin Is `-x` enabled.
	 * @param noCommit Is `--no-commit` enabled.
	 * @returns The ErrorInfo from the executed command.
	 */
	public cherrypickCommit(repo: string, commitHash: string, parentIndex: number, recordOrigin: boolean, noCommit: boolean) {
		const args = ['cherry-pick'];
		if (noCommit) {
			args.push('--no-commit');
		}
		if (recordOrigin) {
			args.push('-x');
		}
		if (getConfig().signCommits) {
			args.push('-S');
		}
		if (parentIndex > 0) {
			args.push('-m', parentIndex.toString());
		}
		args.push(commitHash);
		return this.runGitCommand(args, repo);
	}

	/**
	 * Drop a commit in a repository.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the commit to drop.
	 * @returns The ErrorInfo from the executed command.
	 */
	public dropCommit(repo: string, commitHash: string) {
		const args = ['rebase'];
		if (getConfig().signCommits) {
			args.push('-S');
		}
		args.push('--onto', commitHash + '^', commitHash);
		return this.runGitCommand(args, repo);
	}

	/**
	 * Drop multiple commits in a repository, using a single interactive rebase.
	 * @param repo The path of the repository.
	 * @param commitHashes The hashes of the commits to drop (ordered from newest to oldest).
	 * @returns The ErrorInfo from the executed command.
	 */
	public dropCommits(repo: string, commitHashes: ReadonlyArray<string>) {
		// List the full hash of each commit in the todo list, so that the entries of the commits being dropped can be marked as "drop"
		const args = ['-c', 'rebase.instructionFormat=%H', '-c', 'sequence.editor=sed -i.bak' + commitHashes.map((hash) => ' -e "/ ' + hash + '/s/^[a-z]* /drop /"').join(''), 'rebase', '--interactive'];
		if (getConfig().signCommits) {
			args.push('-S');
		}
		args.push(commitHashes[commitHashes.length - 1] + '^');
		return this.runGitCommand(args, repo);
	}

	/**
	 * Start editing a commit in a repository. An interactive rebase is started that stops at the commit, and the commit is
	 * undone so that its changes are staged. Committing (or running `git rebase --continue`) then replaces the commit, reusing
	 * its message & author, and replays the commits on top of it.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the commit to edit.
	 * @param message The new commit message, or NULL to keep the original message.
	 * @returns The ErrorInfo from the executed command.
	 */
	public async editCommit(repo: string, commitHash: string, message: string | null) {
		// Mark the first entry of the todo list (the commit being edited) as "edit"
		const args = ['-c', 'sequence.editor=sed -i.bak -e "1s/^[a-z]* /edit /"', 'rebase', '--interactive'];
		if (getConfig().signCommits) {
			args.push('-S');
		}
		args.push(commitHash + '^');

		const rebaseStatus = await this.runGitCommand(args, repo);
		if (rebaseStatus !== null) return rebaseStatus;

		// Git creates this file when it stops at an "edit" entry, it records the commit that "git rebase --continue" expects HEAD to be
		let amendFilePath: string;
		try {
			amendFilePath = path.resolve(repo, await this.spawnGit(['rev-parse', '--git-path', 'rebase-merge/amend'], repo, (stdout) => stdout.trim()));
		} catch (errorMessage) {
			return <ErrorInfo>errorMessage;
		}
		if (!fs.existsSync(amendFilePath)) {
			return "Git didn't stop the rebase at commit " + abbrevCommit(commitHash) + '.';
		}

		const resetStatus = await this.runGitCommand(['reset', '--soft', 'HEAD~1'], repo);
		if (resetStatus !== null) return resetStatus;

		// Without this file, "git rebase --continue" commits the staged changes using the original commit's message & author
		try {
			fs.unlinkSync(amendFilePath);
		} catch (_) {
			return 'Unable to remove "' + amendFilePath + '", so "git rebase --continue" won\'t commit the staged changes.';
		}

		if (message !== null) {
			// "git rebase --continue" commits using the message in this file
			const messageFilePath = path.join(path.dirname(amendFilePath), 'message');
			try {
				fs.writeFileSync(messageFilePath, message + '\n');
			} catch (_) {
				return 'Unable to update "' + messageFilePath + '", so the commit will keep its original message.';
			}
		}
		return null;
	}

	/**
	 * Commit the staged changes as a fixup of a commit (to be squashed into it by `git rebase --autosquash`).
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the commit to fixup.
	 * @returns The ErrorInfo from the executed command.
	 */
	public fixupCommit(repo: string, commitHash: string) {
		const args = ['commit', '--fixup=' + commitHash];
		if (getConfig().signCommits) {
			args.push('-S');
		}
		return this.runGitCommand(args, repo);
	}

	/**
	 * Reset the current branch to a specified commit.
	 * @param repo The path of the repository.
	 * @param commit The hash of the commit that the current branch should be reset to.
	 * @param resetMode The mode of the reset.
	 * @returns The ErrorInfo from the executed command.
	 */
	public resetToCommit(repo: string, commit: string, resetMode: GitResetMode) {
		return this.runGitCommand(['reset', '--' + resetMode, commit], repo);
	}

	/**
	 * Revert a commit in a repository.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the commit to revert.
	 * @param parentIndex The parent index if the commit is a merge.
	 * @returns The ErrorInfo from the executed command.
	 */
	public revertCommit(repo: string, commitHash: string, parentIndex: number) {
		const args = ['revert', '--no-edit'];
		if (getConfig().signCommits) {
			args.push('-S');
		}
		if (parentIndex > 0) {
			args.push('-m', parentIndex.toString());
		}
		args.push(commitHash);
		return this.runGitCommand(args, repo);
	}

	/**
	 * Squash multiple consecutive commits in a repository into a single commit. An interactive rebase is started that stops at the
	 * newest commit, the commits are replaced by a single commit containing all of their changes, and then the rebase is continued
	 * to reapply the commits on top of it.
	 * @param repo The path of the repository.
	 * @param commitHashes The hashes of the commits to squash (ordered from newest to oldest).
	 * @param message The message of the squashed commit.
	 * @param noVerify Is `--no-verify` enabled when committing the squashed commit.
	 * @returns The ErrorInfo from the executed command.
	 */
	public async squashCommits(repo: string, commitHashes: ReadonlyArray<string>, message: string, noVerify: boolean) {
		const newestHash = commitHashes[0],
			base = commitHashes[commitHashes.length - 1] + '^',
			signCommits = getConfig().signCommits;

		// Check that no other commits are between the commits (e.g. commits that are hidden from the Git Graph View)
		let count: number;
		try {
			count = await this.spawnGit(['rev-list', '--count', base + '..' + newestHash], repo, (stdout) => parseInt(stdout));
		} catch (errorMessage) {
			return <ErrorInfo>errorMessage;
		}
		if (count !== commitHashes.length) {
			return "The commits can't be squashed, as there are other commits between them.";
		}

		// List the full hash of each commit in the todo list, so that the entry of the newest commit can be marked as "edit"
		const args = ['-c', 'rebase.instructionFormat=%H', '-c', 'sequence.editor=sed -i.bak -e "/ ' + newestHash + '/s/^[a-z]* /edit /"', 'rebase', '--interactive'];
		if (signCommits) {
			args.push('-S');
		}
		args.push(base);

		const rebaseStatus = await this.runGitCommand(args, repo);
		if (rebaseStatus !== null) return rebaseStatus;

		// Git creates this file when it stops at an "edit" entry
		let amendFilePath: string;
		try {
			amendFilePath = path.resolve(repo, await this.spawnGit(['rev-parse', '--git-path', 'rebase-merge/amend'], repo, (stdout) => stdout.trim()));
		} catch (errorMessage) {
			return <ErrorInfo>errorMessage;
		}
		if (!fs.existsSync(amendFilePath)) {
			return "Git didn't stop the rebase at commit " + abbrevCommit(newestHash) + '.';
		}

		// Replace the commits with a single commit containing all of their changes
		const commitArgs = ['commit', '-m', message];
		if (signCommits) {
			commitArgs.push('-S');
		}
		if (noVerify) {
			commitArgs.push('--no-verify');
		}
		let squashStatus = await this.runGitCommand(['reset', '--soft', base], repo);
		if (squashStatus === null) {
			squashStatus = await this.runGitCommand(commitArgs, repo);
		}
		if (squashStatus !== null) {
			// Restore the commits to how they were before the rebase was started
			await this.runGitCommand(['rebase', '--abort'], repo);
			return squashStatus;
		}

		return this.runGitCommand(['rebase', '--continue'], repo);
	}

	/* Git Action Methods - Config */

	/**
	 * Set a configuration value for a repository.
	 * @param repo The path of the repository.
	 * @param key The Git Config Key to be set.
	 * @param value The value to be set.
	 * @param location The location where the configuration value should be set.
	 * @returns The ErrorInfo from the executed command.
	 */
	public setConfigValue(repo: string, key: GitConfigKey, value: string, location: GitConfigLocation) {
		return this.runGitCommand(['config', '--' + location, key, value], repo);
	}

	/**
	 * Unset a configuration value for a repository.
	 * @param repo The path of the repository.
	 * @param key The Git Config Key to be unset.
	 * @param location The location where the configuration value should be unset.
	 * @returns The ErrorInfo from the executed command.
	 */
	public unsetConfigValue(repo: string, key: GitConfigKey, location: GitConfigLocation) {
		return this.runGitCommand(['config', '--' + location, '--unset-all', key], repo);
	}

	/* Git Action Methods - Uncommitted */

	/**
	 * Clean the untracked files in a repository.
	 * @param repo The path of the repository.
	 * @param directories Is `-d` enabled.
	 * @returns The ErrorInfo from the executed command.
	 */
	public cleanUntrackedFiles(repo: string, directories: boolean) {
		return this.runGitCommand(['clean', '-f' + (directories ? 'd' : '')], repo);
	}

	/* Git Action Methods - File */

	/**
	 * Reset a file to the specified revision.
	 * @param repo The path of the repository.
	 * @param commitHash The commit to reset the file to.
	 * @param filePath The file to reset.
	 * @returns The ErrorInfo from the executed command.
	 */
	public resetFileToRevision(repo: string, commitHash: string, filePath: string) {
		return this.runGitCommand(['checkout', commitHash, '--', filePath], repo);
	}

	/* Git Action Methods - Stash */

	/**
	 * Apply a stash in a repository.
	 * @param repo The path of the repository.
	 * @param selector The selector of the stash.
	 * @param reinstateIndex Is `--index` enabled.
	 * @returns The ErrorInfo from the executed command.
	 */
	public applyStash(repo: string, selector: string, reinstateIndex: boolean) {
		let args = ['stash', 'apply'];
		if (reinstateIndex) args.push('--index');
		args.push(selector);

		return this.runGitCommand(args, repo);
	}

	/**
	 * Create a branch from a stash.
	 * @param repo The path of the repository.
	 * @param selector The selector of the stash.
	 * @param branchName The name of the branch to be created.
	 * @returns The ErrorInfo from the executed command.
	 */
	public branchFromStash(repo: string, selector: string, branchName: string) {
		return this.runGitCommand(['stash', 'branch', branchName, selector], repo);
	}

	/**
	 * Drop a stash in a repository.
	 * @param repo The path of the repository.
	 * @param selector The selector of the stash.
	 * @returns The ErrorInfo from the executed command.
	 */
	public dropStash(repo: string, selector: string) {
		return this.runGitCommand(['stash', 'drop', selector], repo);
	}

	/**
	 * Pop a stash in a repository.
	 * @param repo The path of the repository.
	 * @param selector The selector of the stash.
	 * @param reinstateIndex Is `--index` enabled.
	 * @returns The ErrorInfo from the executed command.
	 */
	public popStash(repo: string, selector: string, reinstateIndex: boolean) {
		let args = ['stash', 'pop'];
		if (reinstateIndex) args.push('--index');
		args.push(selector);

		return this.runGitCommand(args, repo);
	}

	/**
	 * Push the uncommitted changes to a stash.
	 * @param repo The path of the repository.
	 * @param message The message of the stash.
	 * @param includeUntracked Is `--include-untracked` enabled.
	 * @returns The ErrorInfo from the executed command.
	 */
	public pushStash(repo: string, message: string, includeUntracked: boolean): Promise<ErrorInfo> {
		if (this.gitExecutable === null) {
			return Promise.resolve(UNABLE_TO_FIND_GIT_MSG);
		} else if (!doesVersionMeetRequirement(this.gitExecutable.version, GitVersionRequirement.PushStash)) {
			return Promise.resolve(constructIncompatibleGitVersionMessage(this.gitExecutable, GitVersionRequirement.PushStash));
		}

		let args = ['stash', 'push'];
		if (includeUntracked) args.push('--include-untracked');
		if (message !== '') args.push('--message', message);
		return this.runGitCommand(args, repo);
	}

	/* Public Utils */

	/**
	 * Opens an external directory diff for the specified commits.
	 * @param repo The path of the repository.
	 * @param fromHash The commit hash the diff is from.
	 * @param toHash The commit hash the diff is to.
	 * @param isGui Is the external diff tool GUI based.
	 * @returns The ErrorInfo from the executed command.
	 */
	public openExternalDirDiff(repo: string, fromHash: string, toHash: string, isGui: boolean) {
		return new Promise<ErrorInfo>((resolve) => {
			if (this.gitExecutable === null) {
				resolve(UNABLE_TO_FIND_GIT_MSG);
			} else {
				const args = ['difftool', '--dir-diff'];
				if (isGui) {
					args.push('-g');
				}
				if (fromHash === toHash) {
					if (toHash === UNCOMMITTED) {
						args.push('HEAD');
					} else {
						args.push(toHash + '^..' + toHash);
					}
				} else {
					if (toHash === UNCOMMITTED) {
						args.push(fromHash);
					} else {
						args.push(fromHash + '..' + toHash);
					}
				}
				if (isGui) {
					this.logger.log('External diff tool is being opened (' + args[args.length - 1] + ')');
					this.runGitCommand(args, repo).then((errorInfo) => {
						this.logger.log('External diff tool has exited (' + args[args.length - 1] + ')');
						if (errorInfo !== null) {
							const errorMessage = errorInfo.replace(EOL_REGEX, ' ');
							this.logger.logError(errorMessage);
							showErrorMessage(errorMessage);
						}
					});
				} else {
					openGitTerminal(repo, this.gitExecutable.path, args.join(' '), 'Open External Directory Diff');
				}
				setTimeout(() => resolve(null), 1500);
			}
		});
	}

	/**
	 * Open a new terminal, set up the Git executable, and optionally run a command.
	 * @param repo The path of the repository.
	 * @param command The command to run.
	 * @param name The name for the terminal.
	 * @returns The ErrorInfo from opening the terminal.
	 */
	public openGitTerminal(repo: string, command: string | null, name: string) {
		return new Promise<ErrorInfo>((resolve) => {
			if (this.gitExecutable === null) {
				resolve(UNABLE_TO_FIND_GIT_MSG);
			} else {
				openGitTerminal(repo, this.gitExecutable.path, command, name);
				setTimeout(() => resolve(null), 1000);
			}
		});
	}

	/* Private Data Providers */

	/**
	 * Get the commits that an interactive rebase of the current branch on a branch or commit would rebase (i.e. the commits in its todo list).
	 * @param repo The path of the repository.
	 * @param obj The object the current branch will be rebased onto.
	 * @returns The commits (ordered from oldest to newest).
	 */
	private async getRebaseCommits(repo: string, obj: string): Promise<GitRebaseCommitData> {
		try {
			const inProgressFilePaths = await this.spawnGit(
				['rev-parse', '--git-path', 'rebase-merge', '--git-path', 'rebase-apply', '--git-path', 'MERGE_HEAD', '--git-path', 'CHERRY_PICK_HEAD', '--git-path', 'REVERT_HEAD'],
				repo,
				(stdout) => stdout.split(EOL_REGEX).slice(0, 5)
			);
			const inProgressOperations = ['A rebase', 'A rebase', 'A merge', 'A cherry pick', 'A revert'];
			const inProgressIndex = inProgressFilePaths.findIndex((filePath) => fs.existsSync(path.resolve(repo, filePath)));
			if (inProgressIndex > -1) {
				return { commits: null, error: inProgressOperations[inProgressIndex] + ' is in progress. Continue or abort it before starting a rebase.' };
			}

			// The same commits that Git lists in the todo list: those not on obj, excluding commits that have already been cherry picked onto obj
			const commits = await this.spawnGit(
				['-c', 'log.showSignature=false', 'log', '--reverse', '--topo-order', '--cherry-pick', '--right-only', '-z', '--format=' + ['%H', '%P', '%B'].join(GIT_LOG_SEPARATOR), obj + '...HEAD', '--'],
				repo,
				(stdout) =>
					stdout
						.split('\0')
						.filter((record) => record !== '')
						.map((record) => {
							const data = record.split(GIT_LOG_SEPARATOR);
							return {
								hash: data[0],
								isMerge: data[1].includes(' '),
								message: removeTrailingBlankLines(data.slice(2).join(GIT_LOG_SEPARATOR).split(EOL_REGEX)).join('\n')
							};
						})
			);
			const mergeCommit = commits.find((commit) => commit.isMerge);
			if (mergeCommit !== undefined) {
				return { commits: null, error: 'Merge commit ' + abbrevCommit(mergeCommit.hash) + " would be rebased, which isn't supported by the Todo Editor (an interactive rebase drops merge commits)." };
			}
			return { commits: commits, error: null };
		} catch (errorMessage) {
			return { commits: null, error: <ErrorInfo>errorMessage };
		}
	}

	/**
	 * Get the branches in a repository.
	 * @param repo The path of the repository.
	 * @param showRemoteBranches Are remote branches shown.
	 * @param hideRemotes An array of hidden remotes.
	 * @returns The branch data.
	 */
	private getBranches(repo: string, showRemoteBranches: boolean, hideRemotes: ReadonlyArray<string>) {
		let args = ['branch'];
		if (showRemoteBranches) args.push('-a');
		args.push('--no-color');

		const hideRemotePatterns = hideRemotes.map((remote) => 'remotes/' + remote + '/');
		const showRemoteHeads = getConfig().showRemoteHeads;

		return this.spawnGit(args, repo, (stdout) => {
			let branchData: GitBranchData = { branches: [], head: null, error: null };
			let lines = stdout.split(EOL_REGEX);
			for (let i = 0; i < lines.length - 1; i++) {
				let name = lines[i].substring(2).split(' -> ')[0];
				if (INVALID_BRANCH_REGEXP.test(name) || hideRemotePatterns.some((pattern) => name.startsWith(pattern)) || (!showRemoteHeads && REMOTE_HEAD_BRANCH_REGEXP.test(name))) {
					continue;
				}

				if (lines[i][0] === '*') {
					branchData.head = name;
					branchData.branches.unshift(name);
				} else {
					branchData.branches.push(name);
				}
			}
			return branchData;
		});
	}

	/**
	 * Get the base commit details for the Commit Details View.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the commit open in the Commit Details View.
	 * @returns The base commit details.
	 */
	private getCommitDetailsBase(repo: string, commitHash: string) {
		return this.spawnGit(['-c', 'log.showSignature=false', 'show', '--quiet', commitHash, '--format=' + this.gitFormatCommitDetails], repo, (stdout): DeepWriteable<GitCommitDetails> => {
			const commitInfo = stdout.split(GIT_LOG_SEPARATOR);
			return {
				hash: commitInfo[0],
				parents: commitInfo[1] !== '' ? commitInfo[1].split(' ') : [],
				author: commitInfo[2],
				authorEmail: commitInfo[3],
				authorDate: parseInt(commitInfo[4]),
				committer: commitInfo[5],
				committerEmail: commitInfo[6],
				committerDate: parseInt(commitInfo[7]),
				signature: parseSignature(commitInfo[8], commitInfo[9], commitInfo[10]),
				body: removeTrailingBlankLines(commitInfo.slice(11).join(GIT_LOG_SEPARATOR).split(EOL_REGEX)).join('\n'),
				fileChanges: []
			};
		});
	}

	/**
	 * Get the configuration list of a repository.
	 * @param repo The path of the repository.
	 * @param location The location of the configuration to be listed.
	 * @returns A set of key-value pairs of Git configuration records.
	 */
	private getConfigList(repo: string, location?: GitConfigLocation): Promise<GitConfigSet> {
		const args = ['--no-pager', 'config', '--list', '-z', '--includes'];
		if (location) {
			args.push('--' + location);
		}

		return this.spawnGit(args, repo, (stdout) => {
			const configs: GitConfigSet = {},
				keyValuePairs = stdout.split('\0');
			const numPairs = keyValuePairs.length - 1;
			let comps, key;
			for (let i = 0; i < numPairs; i++) {
				comps = keyValuePairs[i].split(EOL_REGEX);
				key = comps.shift()!;
				configs[key] = comps.join('\n');
			}
			return configs;
		}).catch((errorMessage) => {
			if (typeof errorMessage === 'string') {
				const message = errorMessage.toLowerCase();
				if (message.startsWith('fatal: unable to read config file') && message.endsWith('no such file or directory')) {
					// If the Git command failed due to the configuration file not existing, return an empty list instead of throwing the exception
					return {};
				}
			} else {
				errorMessage = 'An unexpected error occurred while spawning the Git child process.';
			}
			throw errorMessage;
		});
	}

	/**
	 * Get the diff `--name-status` records.
	 * @param repo The path of the repository.
	 * @param fromHash The revision the diff is from.
	 * @param toHash The revision the diff is to.
	 * @param filter The types of file changes to retrieve (defaults to `AMDR`).
	 * @returns An array of `--name-status` records.
	 */
	private getDiffNameStatus(repo: string, fromHash: string, toHash: string, filter: string = 'AMDR') {
		return this.execDiff(repo, fromHash, toHash, '--name-status', filter).then((output) => {
			let records: DiffNameStatusRecord[] = [],
				i = 0;
			while (i < output.length && output[i] !== '') {
				let type = <GitFileStatus>output[i][0];
				if (type === GitFileStatus.Added || type === GitFileStatus.Deleted || type === GitFileStatus.Modified) {
					// Add, Modify, or Delete
					let p = getPathFromStr(output[i + 1]);
					records.push({ type: type, oldFilePath: p, newFilePath: p });
					i += 2;
				} else if (type === GitFileStatus.Renamed) {
					// Rename
					records.push({ type: type, oldFilePath: getPathFromStr(output[i + 1]), newFilePath: getPathFromStr(output[i + 2]) });
					i += 3;
				} else {
					break;
				}
			}
			return records;
		});
	}

	/**
	 * Get the diff `--numstat` records.
	 * @param repo The path of the repository.
	 * @param fromHash The revision the diff is from.
	 * @param toHash The revision the diff is to.
	 * @param filter The types of file changes to retrieve (defaults to `AMDR`).
	 * @returns An array of `--numstat` records.
	 */
	private getDiffNumStat(repo: string, fromHash: string, toHash: string, filter: string = 'AMDR') {
		return this.execDiff(repo, fromHash, toHash, '--numstat', filter).then((output) => {
			let records: DiffNumStatRecord[] = [],
				i = 0;
			while (i < output.length && output[i] !== '') {
				let fields = output[i].split('\t');
				if (fields.length !== 3) break;
				if (fields[2] !== '') {
					// Add, Modify, or Delete
					records.push({ filePath: getPathFromStr(fields[2]), additions: parseInt(fields[0]), deletions: parseInt(fields[1]) });
					i += 1;
				} else {
					// Rename
					records.push({ filePath: getPathFromStr(output[i + 2]), additions: parseInt(fields[0]), deletions: parseInt(fields[1]) });
					i += 3;
				}
			}
			return records;
		});
	}

	/**
	 * Get the raw commits in a repository.
	 * @param repo The path of the repository.
	 * @param branches The list of branch heads to display, or NULL (show all).
	 * @param num The maximum number of commits to return.
	 * @param includeTags Include commits only referenced by tags.
	 * @param includeRemotes Include remote branches.
	 * @param includeCommitsMentionedByReflogs Include commits mentioned by reflogs.
	 * @param onlyFollowFirstParent Only follow the first parent of commits.
	 * @param order The order for commits to be returned.
	 * @param remotes An array of the known remotes.
	 * @param hideRemotes An array of hidden remotes.
	 * @param stashes An array of all stashes in the repository.
	 * @param simplifyByDecoration Only return commits that are referenced by a branch or tag.
	 * @param paths Only return commits that modified these paths (all commits are returned if empty).
	 * @param simplifyMerges Also return the merge commits needed to connect the commits that modified the paths, and rewrite the parents of the commits to their nearest returned ancestors.
	 * @param showSignatures Include the signature status of each commit.
	 * @returns An array of commits.
	 */
	private getLog(
		repo: string,
		branches: ReadonlyArray<string> | null,
		num: number,
		includeTags: boolean,
		includeRemotes: boolean,
		includeCommitsMentionedByReflogs: boolean,
		onlyFollowFirstParent: boolean,
		order: CommitOrdering,
		remotes: ReadonlyArray<string>,
		hideRemotes: ReadonlyArray<string>,
		stashes: ReadonlyArray<GitStash>,
		simplifyByDecoration: boolean,
		paths: ReadonlyArray<string>,
		simplifyMerges: boolean,
		showSignatures: boolean
	) {
		const includeSignatures = showSignatures && this.gitExecutableSupportsGpgInfo;
		const format = includeSignatures ? [this.gitFormatLog, '%G?', '%GS', '%GK'].join(GIT_LOG_SEPARATOR) : this.gitFormatLog;
		const args = ['-c', 'log.showSignature=false', 'log', '--max-count=' + num, '--format=' + format, '--' + order + '-order'];
		if (simplifyByDecoration) {
			args.push('--simplify-by-decoration');
		}
		if (simplifyMerges) {
			args.push('--full-history', '--simplify-merges');
		}
		if (onlyFollowFirstParent) {
			args.push('--first-parent');
		}
		if (branches !== null) {
			for (let i = 0; i < branches.length; i++) {
				args.push(branches[i]);
			}
		} else {
			// Show All
			args.push('--branches');
			if (includeTags) args.push('--tags');
			else if (simplifyByDecoration) args.push('--decorate-refs-exclude=refs/tags/'); // Commits only referenced by hidden tags aren't shown
			if (includeCommitsMentionedByReflogs) args.push('--reflog');
			if (includeRemotes) {
				if (hideRemotes.length === 0) {
					args.push('--remotes');
				} else {
					remotes
						.filter((remote) => !hideRemotes.includes(remote))
						.forEach((remote) => {
							args.push('--glob=refs/remotes/' + remote);
						});
				}
			}

			// Add the unique list of base hashes of stashes, so that commits only referenced by stashes are displayed
			const stashBaseHashes = stashes.map((stash) => stash.baseHash);
			stashBaseHashes.filter((hash, index) => stashBaseHashes.indexOf(hash) === index).forEach((hash) => args.push(hash));

			args.push('HEAD');
		}
		args.push('--', ...paths);

		return this.spawnGit(args, repo, (stdout) => {
			let lines = stdout.split(EOL_REGEX);
			let commits: GitCommitRecord[] = [];
			for (let i = 0; i < lines.length - 1; i++) {
				let line = lines[i].split(GIT_LOG_SEPARATOR);
				if (line.length !== (includeSignatures ? 9 : 6)) break;
				commits.push({
					hash: line[0],
					parents: line[1] !== '' ? line[1].split(' ') : [],
					author: line[2],
					email: line[3],
					date: parseInt(line[4]),
					message: line[5],
					signature: includeSignatures ? parseSignature(line[6], line[7], line[8]) : null
				});
			}
			return commits;
		});
	}

	/**
	 * Get the nearest ancestor of each of the specified commits that is in a set of commits.
	 * @param repo The path of the repository.
	 * @param hashes The commits to find the nearest ancestors of.
	 * @param commitLookup The set of commits.
	 * @param oldestDate The date of the oldest commit in the set (older commits aren't searched).
	 * @returns A mapping from each commit to its nearest ancestor (commits without an ancestor in the set are not included).
	 */
	private getNearestAncestorsInSet(repo: string, hashes: ReadonlyArray<string>, commitLookup: { [hash: string]: number }, oldestDate: number) {
		return this.spawnGit(['rev-list', '--topo-order', '--parents', '--max-age=' + oldestDate, ...hashes, '--'], repo, (stdout) => {
			const ancestors: { [hash: string]: string } = {};
			const reachableFrom: { [hash: string]: string[] } = {}; // The commits in "hashes" that each commit is reachable from, before reaching a commit in the set
			hashes.forEach((hash) => (reachableFrom[hash] = [hash]));

			// Topological order ensures all children of a commit are processed before the commit
			const lines = stdout.split(EOL_REGEX);
			for (let i = 0; i < lines.length - 1; i++) {
				const line = lines[i].split(' '),
					from = reachableFrom[line[0]];
				if (typeof from === 'undefined') continue;
				if (typeof commitLookup[line[0]] === 'number') {
					from.forEach((hash) => {
						if (typeof ancestors[hash] === 'undefined') ancestors[hash] = line[0];
					});
				} else {
					for (let j = 1; j < line.length; j++) {
						const parentFrom = reachableFrom[line[j]] || (reachableFrom[line[j]] = []);
						from.forEach((hash) => {
							if (!parentFrom.includes(hash)) parentFrom.push(hash);
						});
					}
				}
			}
			return ancestors;
		});
	}

	/**
	 * Get the references in a repository.
	 * @param repo The path of the repository.
	 * @param showRemoteBranches Are remote branches shown.
	 * @param showRemoteHeads Are remote heads shown.
	 * @param hideRemotes An array of hidden remotes.
	 * @returns The references data.
	 */
	private getRefs(repo: string, showRemoteBranches: boolean, showRemoteHeads: boolean, hideRemotes: ReadonlyArray<string>) {
		let args = ['show-ref'];
		if (!showRemoteBranches) args.push('--heads', '--tags');
		args.push('-d', '--head');

		const hideRemotePatterns = hideRemotes.map((remote) => 'refs/remotes/' + remote + '/');

		return this.spawnGit(args, repo, (stdout) => {
			let refData: GitRefData = { head: null, heads: [], tags: [], remotes: [] };
			let lines = stdout.split(EOL_REGEX);
			for (let i = 0; i < lines.length - 1; i++) {
				let line = lines[i].split(' ');
				if (line.length < 2) continue;

				let hash = line.shift()!;
				let ref = line.join(' ');

				if (ref.startsWith('refs/heads/')) {
					refData.heads.push({ hash: hash, name: ref.substring(11) });
				} else if (ref.startsWith('refs/tags/')) {
					let annotated = ref.endsWith('^{}');
					refData.tags.push({ hash: hash, name: annotated ? ref.substring(10, ref.length - 3) : ref.substring(10), annotated: annotated });
				} else if (ref.startsWith('refs/remotes/')) {
					if (!hideRemotePatterns.some((pattern) => ref.startsWith(pattern)) && (showRemoteHeads || !ref.endsWith('/HEAD'))) {
						refData.remotes.push({ hash: hash, name: ref.substring(13) });
					}
				} else if (ref === 'HEAD') {
					refData.head = hash;
				}
			}
			return refData;
		});
	}

	/**
	 * Get all of the remotes that contain the specified commit hash.
	 * @param repo The path of the repository.
	 * @param commitHash The commit hash to test.
	 * @param knownRemotes The list of known remotes to check for.
	 * @returns A promise resolving to a list of remote names.
	 */
	private getRemotesContainingCommit(repo: string, commitHash: string, knownRemotes: string[]) {
		return this.spawnGit(['branch', '-r', '--no-color', '--contains=' + commitHash], repo, (stdout) => {
			// Get the names of all known remote branches that contain commitHash
			const branchNames = stdout
				.split(EOL_REGEX)
				.filter((line) => line.length > 2)
				.map((line) => line.substring(2).split(' -> ')[0])
				.filter((branchName) => !INVALID_BRANCH_REGEXP.test(branchName));

			// Get all the remotes that are the prefix of at least one remote branch name
			return knownRemotes.filter((knownRemote) => {
				const knownRemotePrefix = knownRemote + '/';
				return branchNames.some((branchName) => branchName.startsWith(knownRemotePrefix));
			});
		});
	}

	/**
	 * Get the stashes in a repository.
	 * @param repo The path of the repository.
	 * @returns An array of stashes.
	 */
	private getStashes(repo: string) {
		return this.spawnGit(['reflog', '--format=' + this.gitFormatStash, 'refs/stash', '--'], repo, (stdout) => {
			let lines = stdout.split(EOL_REGEX);
			let stashes: GitStash[] = [];
			for (let i = 0; i < lines.length - 1; i++) {
				let line = lines[i].split(GIT_LOG_SEPARATOR);
				if (line.length !== 7 || line[1] === '') continue;
				let parentHashes = line[1].split(' ');
				stashes.push({
					hash: line[0],
					baseHash: parentHashes[0],
					untrackedFilesHash: parentHashes.length === 3 ? parentHashes[2] : null,
					selector: line[2],
					author: line[3],
					email: line[4],
					date: parseInt(line[5]),
					message: line[6]
				});
			}
			return stashes;
		}).catch(() => <GitStash[]>[]);
	}

	/**
	 * Get the names of the remotes of a repository.
	 * @param repo The path of the repository.
	 * @returns An array of remote names.
	 */
	private getRemotes(repo: string) {
		return this.spawnGit(['remote'], repo, (stdout) => {
			let lines = stdout.split(EOL_REGEX);
			lines.pop();
			return lines;
		});
	}

	/**
	 * Get the signature of a signed tag.
	 * @param repo The path of the repository.
	 * @param ref The reference identifying the tag.
	 * @returns A Promise resolving to the signature.
	 */
	private getTagSignature(repo: string, ref: string): Promise<GitSignature> {
		return this._spawnGit(['verify-tag', '--raw', ref], repo, (stdout, stderr) => stderr || stdout.toString(), true)
			.then((output) => {
				const records = output
					.split(EOL_REGEX)
					.filter((line) => line.startsWith('[GNUPG:] '))
					.map((line) => line.split(' '));

				let signature: Writeable<GitSignature> | null = null,
					trustLevel: string | null = null,
					parsingDetails: GpgStatusCodeParsingDetails | undefined;
				for (let i = 0; i < records.length; i++) {
					parsingDetails = GPG_STATUS_CODE_PARSING_DETAILS[records[i][1]];
					if (parsingDetails) {
						if (signature !== null) {
							throw new Error("Multiple Signatures Exist: As Git currently doesn't support them, nor does Git Graph (for consistency).");
						} else {
							signature = {
								status: parsingDetails.status,
								key: records[i][2],
								signer: parsingDetails.uid ? records[i].slice(3).join(' ') : '' // When parsingDetails.uid === TRUE, the signer is the rest of the record (so join the remaining arguments)
							};
						}
					} else if (records[i][1].startsWith('TRUST_')) {
						trustLevel = records[i][1];
					}
				}

				if (signature !== null && signature.status === GitSignatureStatus.GoodAndValid && (trustLevel === 'TRUST_UNDEFINED' || trustLevel === 'TRUST_NEVER')) {
					signature.status = GitSignatureStatus.GoodWithUnknownValidity;
				}

				if (signature !== null) {
					return signature;
				} else {
					throw new Error('No Signature could be parsed.');
				}
			})
			.catch(() => ({
				status: GitSignatureStatus.CannotBeChecked,
				key: '',
				signer: ''
			}));
	}

	/**
	 * Get the number of uncommitted changes in a repository.
	 * @param repo The path of the repository.
	 * @returns The number of uncommitted changes.
	 */
	private getUncommittedChanges(repo: string) {
		return this.spawnGit(['status', '--untracked-files=' + (getConfig().showUntrackedFiles ? 'all' : 'no'), '--porcelain'], repo, (stdout) => {
			const numLines = stdout.split(EOL_REGEX).length;
			return numLines > 1 ? numLines - 1 : 0;
		});
	}

	/**
	 * Get the untracked and deleted files that are not staged or committed.
	 * @param repo The path of the repository.
	 * @returns The untracked and deleted files.
	 */
	private getStatus(repo: string) {
		return this.spawnGit(['status', '-s', '--untracked-files=' + (getConfig().showUntrackedFiles ? 'all' : 'no'), '--porcelain', '-z'], repo, (stdout) => {
			let output = stdout.split('\0'),
				i = 0;
			let status: GitStatusFiles = { deleted: [], untracked: [] };
			let path = '',
				c1 = '',
				c2 = '';
			while (i < output.length && output[i] !== '') {
				if (output[i].length < 4) break;
				path = output[i].substring(3);
				c1 = output[i].substring(0, 1);
				c2 = output[i].substring(1, 2);
				if (c1 === 'D' || c2 === 'D') status.deleted.push(path);
				else if (c1 === '?' || c2 === '?') status.untracked.push(path);

				if (c1 === 'R' || c2 === 'R' || c1 === 'C' || c2 === 'C') {
					// Renames or copies
					i += 2;
				} else {
					i += 1;
				}
			}
			return status;
		});
	}

	/* Private Utils */

	/**
	 * Check if there are staged changes that resulted from a squash merge, and if so, commit them.
	 * @param repo The path of the repository.
	 * @param obj The object being squash merged into the current branch.
	 * @param actionOn Is the merge on a branch, remote-tracking branch or commit.
	 * @param squashMessageFormat The format to be used in the commit message of the squash.
	 * @param noVerify Is `--no-verify` enabled.
	 * @returns The ErrorInfo from the executed command.
	 */
	private commitSquashIfStagedChangesExist(repo: string, obj: string, actionOn: MergeActionOn, squashMessageFormat: SquashMessageFormat, signCommits: boolean, noVerify: boolean): Promise<ErrorInfo> {
		return this.areStagedChanges(repo).then((changes) => {
			if (changes) {
				const args = ['commit'];
				if (signCommits) {
					args.push('-S');
				}
				if (noVerify) {
					args.push('--no-verify');
				}
				if (squashMessageFormat === SquashMessageFormat.Default) {
					args.push('-m', 'Merge ' + actionOn.toLowerCase() + " '" + obj + "'");
				} else {
					args.push('--no-edit');
				}
				return this.runGitCommand(args, repo);
			} else {
				return null;
			}
		});
	}

	/**
	 * Get the diff between two revisions.
	 * @param repo The path of the repository.
	 * @param fromHash The revision the diff is from.
	 * @param toHash The revision the diff is to.
	 * @param arg Sets the data reported from the diff.
	 * @param filter The types of file changes to retrieve.
	 * @returns The diff output.
	 */
	private execDiff(repo: string, fromHash: string, toHash: string, arg: '--numstat' | '--name-status', filter: string) {
		let args: string[];
		if (fromHash === toHash) {
			args = ['diff-tree', arg, '-r', '--root', '--find-renames', '--diff-filter=' + filter, '-z', fromHash];
		} else {
			args = ['diff', arg, '--find-renames', '--diff-filter=' + filter, '-z', fromHash];
			if (toHash !== '') args.push(toHash);
		}

		return this.spawnGit(args, repo, (stdout) => {
			let lines = stdout.split('\0');
			if (fromHash === toHash) lines.shift();
			return lines;
		});
	}

	/**
	 * Get the todo list entry that amends the current commit of an interactive rebase, setting its message.
	 * @param repo The path of the repository.
	 * @param messages The messages to join into the commit message.
	 * @param signCommits Should the amended commit be signed.
	 * @returns The todo list entry.
	 */
	private async getRebaseTodoAmendEntry(repo: string, messages: ReadonlyArray<string>, signCommits: boolean) {
		// The message is read from a blob, so that it's never interpreted by the shell that runs the "exec" entry
		const messageBlob = await this.writeBlob(repo, messages.filter((message) => message !== '').join('\n\n'));
		return 'exec git cat-file blob ' + messageBlob + ' | git commit --amend --allow-empty --no-verify ' + (signCommits ? '-S ' : '') + '-F -';
	}

	/**
	 * Run a Git command (typically for a Git Graph View action).
	 * @param args The arguments to pass to Git.
	 * @param repo The repository to run the command in.
	 * @returns The returned ErrorInfo (suitable for being sent to the Git Graph View).
	 */
	private runGitCommand(args: string[], repo: string): Promise<ErrorInfo> {
		return this._spawnGit(args, repo, () => null).catch((errorMessage: string) => errorMessage);
	}

	/**
	 * Spawn Git, with the return value resolved from `stdout` as a string.
	 * @param args The arguments to pass to Git.
	 * @param repo The repository to run the command in.
	 * @param resolveValue A callback invoked to resolve the data from `stdout`.
	 */
	private spawnGit<T>(args: string[], repo: string, resolveValue: { (stdout: string): T }) {
		return this._spawnGit(args, repo, (stdout) => resolveValue(stdout.toString()));
	}

	/**
	 * Spawn Git, with the return value resolved from `stdout` as a buffer.
	 * @param args The arguments to pass to Git.
	 * @param repo The repository to run the command in.
	 * @param resolveValue A callback invoked to resolve the data from `stdout` and `stderr`.
	 * @param ignoreExitCode Ignore the exit code returned by Git (default: `FALSE`).
	 * @param stdin The data to write to Git's `stdin` (default: `NULL`, nothing is written).
	 */
	private _spawnGit<T>(args: string[], repo: string, resolveValue: { (stdout: Buffer, stderr: string): T }, ignoreExitCode: boolean = false, stdin: string | null = null) {
		return new Promise<T>((resolve, reject) => {
			if (this.gitExecutable === null) {
				return reject(UNABLE_TO_FIND_GIT_MSG);
			}

			const env: NodeJS.ProcessEnv = Object.assign({}, process.env, this.askpassEnv);
			// GIT_SEQUENCE_EDITOR takes precedence over the sequence.editor config used by the interactive rebases Git Graph runs
			delete env.GIT_SEQUENCE_EDITOR;
			const gitProcess = cp.spawn(this.gitExecutable.path, args, {
				cwd: repo,
				env: env
			});
			if (stdin !== null) {
				gitProcess.stdin.end(stdin);
			}
			resolveSpawnOutput(gitProcess).then((values) => {
				const status = values[0],
					stdout = values[1],
					stderr = values[2];
				if (status.code === 0 || ignoreExitCode) {
					resolve(resolveValue(stdout, stderr));
				} else {
					reject(getErrorMessage(status.error, stdout, stderr));
				}
			});

			this.logger.logCmd('git', args);
		});
	}

	/**
	 * Write a blob to the object database of a repository.
	 * @param repo The path of the repository.
	 * @param content The content of the blob.
	 * @returns The hash of the blob.
	 */
	private writeBlob(repo: string, content: string) {
		return this._spawnGit(['hash-object', '-w', '--stdin'], repo, (stdout) => stdout.toString().trim(), false, content);
	}
}

/**
 * Generates the file changes from the diff output and status information.
 * @param nameStatusRecords The `--name-status` records.
 * @param numStatRecords The `--numstat` records.
 * @param status The deleted and untracked files.
 * @returns An array of file changes.
 */
function generateFileChanges(nameStatusRecords: DiffNameStatusRecord[], numStatRecords: DiffNumStatRecord[], status: GitStatusFiles | null) {
	let fileChanges: Writeable<GitFileChange>[] = [],
		fileLookup: { [file: string]: number } = {},
		i = 0;

	for (i = 0; i < nameStatusRecords.length; i++) {
		fileLookup[nameStatusRecords[i].newFilePath] = fileChanges.length;
		fileChanges.push({ oldFilePath: nameStatusRecords[i].oldFilePath, newFilePath: nameStatusRecords[i].newFilePath, type: nameStatusRecords[i].type, additions: null, deletions: null });
	}

	if (status !== null) {
		let filePath;
		for (i = 0; i < status.deleted.length; i++) {
			filePath = getPathFromStr(status.deleted[i]);
			if (typeof fileLookup[filePath] === 'number') {
				fileChanges[fileLookup[filePath]].type = GitFileStatus.Deleted;
			} else {
				fileChanges.push({ oldFilePath: filePath, newFilePath: filePath, type: GitFileStatus.Deleted, additions: null, deletions: null });
			}
		}
		for (i = 0; i < status.untracked.length; i++) {
			filePath = getPathFromStr(status.untracked[i]);
			fileChanges.push({ oldFilePath: filePath, newFilePath: filePath, type: GitFileStatus.Untracked, additions: null, deletions: null });
		}
	}

	for (i = 0; i < numStatRecords.length; i++) {
		if (typeof fileLookup[numStatRecords[i].filePath] === 'number') {
			fileChanges[fileLookup[numStatRecords[i].filePath]].additions = numStatRecords[i].additions;
			fileChanges[fileLookup[numStatRecords[i].filePath]].deletions = numStatRecords[i].deletions;
		}
	}

	return fileChanges;
}

/**
 * Get the specified config value from a set of key-value config pairs.
 * @param configs A set key-value pairs of Git configuration records.
 * @param key The key of the desired config.
 * @returns The value for `key` if it exists, otherwise NULL.
 */
function getConfigValue(configs: GitConfigSet, key: string) {
	return typeof configs[key] !== 'undefined' ? configs[key] : null;
}

/**
 * Produce a suitable error message from a spawned Git command that terminated with an erroneous status code.
 * @param error An error generated by JavaScript (optional).
 * @param stdoutBuffer A buffer containing the data outputted to `stdout`.
 * @param stderr A string containing the data outputted to `stderr`.
 * @returns A suitable error message.
 */
function getErrorMessage(error: Error | null, stdoutBuffer: Buffer, stderr: string) {
	let stdout = stdoutBuffer.toString(),
		lines: string[];
	if (stdout !== '' || stderr !== '') {
		lines = (stderr + stdout).split(EOL_REGEX);
		lines.pop();
	} else if (error) {
		lines = error.message.split(EOL_REGEX);
	} else {
		lines = [];
	}
	return lines.join('\n');
}

/**
 * Parse the signature of a commit, from the output of the `%G?`, `%GS` & `%GK` format placeholders.
 * @param status The signature status.
 * @param signer The signer of the signature.
 * @param key The key used to make the signature.
 * @returns The signature, or NULL if the commit isn't signed.
 */
function parseSignature(status: string, signer: string, key: string): GitSignature | null {
	return ['G', 'U', 'X', 'Y', 'R', 'E', 'B'].includes(status) ? { key: key.trim(), signer: signer.trim(), status: <GitSignatureStatus>status } : null;
}

/**
 * Rearrange the entries of a rebase todo list in the same way as `git rebase --autosquash`: each "fixup!" / "squash!" commit is moved
 * after the commit it targets (and any commits already targeting it), with its action changed to fixup / squash.
 * @param entries The todo list entries (ordered from oldest to newest).
 * @returns The rearranged todo list entries.
 */
function rearrangeAutosquashEntries(entries: ReadonlyArray<RebaseTodoEntry>) {
	const groups: RebaseTodoEntry[][] = [],
		groupLookup = new Map<string, RebaseTodoEntry[]>();
	for (const entry of entries) {
		const subject = entry.message.split(EOL_REGEX)[0];
		const match = subject.match(AUTOSQUASH_SUBJECT_REGEXP);
		if (match !== null) {
			// The target is identified by its subject, by its (abbreviated) hash, or by the start of its subject (in that order of precedence)
			let target = subject;
			while (AUTOSQUASH_SUBJECT_REGEXP.test(target)) {
				target = target.replace(AUTOSQUASH_SUBJECT_REGEXP, '');
			}
			const group =
				groupLookup.get(target) ||
				groups.find((group) => /^[0-9a-f]{4,}$/.test(target) && group[0].hash.startsWith(target)) ||
				groups.find((group) => target !== '' && group[0].message.startsWith(target));
			if (group !== undefined) {
				group.push({ hash: entry.hash, action: match[1] === 'fixup' ? RebaseTodoAction.Fixup : RebaseTodoAction.Squash, message: entry.message });
				continue;
			}
		}
		const group = [entry];
		groups.push(group);
		if (!groupLookup.has(subject)) groupLookup.set(subject, group);
	}
	return groups.flat();
}

/**
 * Remove trailing blank lines from an array of lines.
 * @param lines The array of lines.
 * @returns The same array.
 */
function removeTrailingBlankLines(lines: string[]) {
	while (lines.length > 0 && lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines;
}

/**
 * Get all the unique strings from an array of strings.
 * @param items The array of strings with duplicates.
 * @returns An array of unique strings.
 */
function unique(items: ReadonlyArray<string>) {
	const uniqueItems: { [item: string]: true } = {};
	items.forEach((item) => (uniqueItems[item] = true));
	return Object.keys(uniqueItems);
}

/* Types */

interface DiffNameStatusRecord {
	type: GitFileStatus;
	oldFilePath: string;
	newFilePath: string;
}

interface DiffNumStatRecord {
	filePath: string;
	additions: number;
	deletions: number;
}

interface GitBranchData {
	branches: string[];
	head: string | null;
	error: ErrorInfo;
}

interface GitCommitRecord {
	hash: string;
	parents: string[];
	author: string;
	email: string;
	date: number;
	message: string;
	signature: GitSignature | null;
}

interface GitCommitData {
	commits: GitCommit[];
	head: string | null;
	tags: string[];
	moreCommitsAvailable: boolean;
	error: ErrorInfo;
}

export interface GitCommitDetailsData {
	commitDetails: GitCommitDetails | null;
	error: ErrorInfo;
}

interface GitCommitComparisonData {
	fileChanges: GitFileChange[];
	error: ErrorInfo;
}

type GitConfigSet = { [key: string]: string };

interface GitRef {
	hash: string;
	name: string;
}

interface GitRefTag extends GitRef {
	annotated: boolean;
}

interface GitRefData {
	head: string | null;
	heads: GitRef[];
	tags: GitRefTag[];
	remotes: GitRef[];
}

interface GitRebaseCommitData {
	commits: { hash: string; isMerge: boolean; message: string }[] | null;
	error: ErrorInfo;
}

export interface GitRebaseTodoListData {
	entries: RebaseTodoEntry[] | null;
	error: ErrorInfo;
}

interface GitRepoInfo extends GitBranchData {
	remotes: string[];
	stashes: GitStash[];
}

interface GitRepoConfigData {
	config: GitRepoConfig | null;
	error: ErrorInfo;
}

interface GitStatusFiles {
	deleted: string[];
	untracked: string[];
}

interface GitCommitMessageData {
	message: string | null;
	error: ErrorInfo;
}

interface GitTagDetailsData {
	details: GitTagDetails | null;
	error: ErrorInfo;
}

interface GpgStatusCodeParsingDetails {
	readonly status: GitSignatureStatus;
	readonly uid: boolean;
}
