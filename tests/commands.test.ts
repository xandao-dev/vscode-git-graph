import type { MockInstance } from 'vite-plus/test';
import * as date from './mocks/date';
import * as vscode from './mocks/vscode';
vi.mock('../src/avatarManager');
vi.mock('../src/dataSource');
vi.mock('../src/extensionState');
vi.mock('../src/gitGraphView');
vi.mock('../src/logger');
vi.mock('../src/repoManager');
vi.mock('os', { spy: true });

import * as os from 'os';
import { ConfigurationChangeEvent } from 'vscode';
import { AvatarManager } from '../src/avatarManager';
import { CommandManager } from '../src/commands';
import { DataSource } from '../src/dataSource';
import { DiffSide, encodeDiffDocUri } from '../src/diffDocProvider';
import { ExtensionState } from '../src/extensionState';
import { GitGraphView } from '../src/gitGraphView';
import { Logger } from '../src/logger';
import { RepoManager } from '../src/repoManager';
import { GitFileStatus, RepoDropdownOrder } from '../src/types';
import * as utils from '../src/utils';
import { EventEmitter } from '../src/utils/event';

import { waitForExpect } from './helpers/expectations';
import { mockRepoState } from './helpers/utils';

let onDidChangeConfiguration: EventEmitter<ConfigurationChangeEvent>;
let onDidChangeGitExecutable: EventEmitter<utils.GitExecutable>;
let logger: Logger;
let dataSource: DataSource;
let extensionState: ExtensionState;
let avatarManager: AvatarManager;
let repoManager: RepoManager;
let spyOnGitGraphViewCreateOrShow: MockInstance,
	spyOnGetRepos: MockInstance,
	spyOnGetKnownRepo: MockInstance,
	spyOnRegisterRepo: MockInstance,
	spyOnGetCodeReviews: MockInstance,
	spyOnEndCodeReview: MockInstance,
	spyOnGetCommitSubject: MockInstance,
	spyOnLog: MockInstance;
beforeAll(() => {
	onDidChangeConfiguration = new EventEmitter<ConfigurationChangeEvent>();
	onDidChangeGitExecutable = new EventEmitter<utils.GitExecutable>();
	logger = new Logger();
	dataSource = new DataSource(null, onDidChangeConfiguration.subscribe, onDidChangeGitExecutable.subscribe, logger);
	extensionState = new ExtensionState(vscode.mocks.extensionContext, onDidChangeGitExecutable.subscribe);
	avatarManager = new AvatarManager(dataSource, extensionState, logger);
	repoManager = new RepoManager(dataSource, extensionState, onDidChangeConfiguration.subscribe, logger);
	spyOnGitGraphViewCreateOrShow = vi.spyOn(GitGraphView, 'createOrShow');
	spyOnGetRepos = vi.spyOn(repoManager, 'getRepos');
	spyOnGetKnownRepo = vi.spyOn(repoManager, 'getKnownRepo');
	spyOnRegisterRepo = vi.spyOn(repoManager, 'registerRepo');
	spyOnGetCodeReviews = vi.spyOn(extensionState, 'getCodeReviews');
	spyOnEndCodeReview = vi.spyOn(extensionState, 'endCodeReview');
	spyOnGetCommitSubject = vi.spyOn(dataSource, 'getCommitSubject');
	spyOnLog = vi.spyOn(logger, 'log');
});

afterAll(() => {
	repoManager.dispose();
	avatarManager.dispose();
	extensionState.dispose();
	dataSource.dispose();
	logger.dispose();
	onDidChangeConfiguration.dispose();
	onDidChangeGitExecutable.dispose();
});

describe('CommandManager', () => {
	let commandManager: CommandManager;
	beforeEach(() => {
		commandManager = new CommandManager(
			vscode.mocks.extensionContext,
			avatarManager,
			dataSource,
			extensionState,
			repoManager,
			{ path: '/path/to/git', version: '2.25.0' },
			onDidChangeGitExecutable.subscribe,
			logger
		);
	});
	afterEach(() => {
		commandManager.dispose();
	});

	it('Should construct a CommandManager, and be disposed', () => {
		// Assert
		expect(commandManager['disposables']).toHaveLength(12);
		expect(commandManager['gitExecutable']).toStrictEqual({
			path: '/path/to/git',
			version: '2.25.0'
		});

		// Run
		commandManager.dispose();

		// Assert
		expect(commandManager['disposables']).toHaveLength(0);
	});

	it('Should process onDidChangeGitExecutable events', () => {
		// Run
		onDidChangeGitExecutable.emit({
			path: '/path/to/other-git',
			version: '2.26.0'
		});

		// Assert
		expect(commandManager['gitExecutable']).toStrictEqual({
			path: '/path/to/other-git',
			version: '2.26.0'
		});
	});

	describe('git-graph.view', () => {
		it('Should open the Git Graph View', async () => {
			// Setup
			vscode.mockExtensionSettingReturnValue('openToTheRepoOfTheActiveTextEditorDocument', false);

			// Run
			vscode.commands.executeCommand('git-graph.view');

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.view');
				expect(spyOnGitGraphViewCreateOrShow).toHaveBeenCalledWith('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);
			});
		});

		it('Should open the Git Graph View to the known repository', async () => {
			// Setup
			spyOnGetKnownRepo.mockResolvedValueOnce('/path/to/workspace-folder/repo');
			vscode.mockExtensionSettingReturnValue('openToTheRepoOfTheActiveTextEditorDocument', false);

			// Run
			vscode.commands.executeCommand('git-graph.view', { rootUri: vscode.Uri.file('/path/to/workspace-folder/repo') });

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.view');
				expect(spyOnGitGraphViewCreateOrShow).toHaveBeenCalledWith('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, { repo: '/path/to/workspace-folder/repo' });
			});
		});

		it('Should open the Git Graph View to a newly registered repository', async () => {
			// Setup
			spyOnGetKnownRepo.mockResolvedValueOnce(null);
			spyOnRegisterRepo.mockResolvedValueOnce({ root: '/path/to/workspace-folder/repo', error: null });
			vscode.mockExtensionSettingReturnValue('openToTheRepoOfTheActiveTextEditorDocument', false);

			// Run
			vscode.commands.executeCommand('git-graph.view', { rootUri: vscode.Uri.file('/path/to/workspace-folder/repo') });

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.view');
				expect(spyOnGitGraphViewCreateOrShow).toHaveBeenCalledWith('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, { repo: '/path/to/workspace-folder/repo' });
			});
		});

		it('Should open the Git Graph View to the repository containing the active text editor', async () => {
			// Setup
			vscode.window.activeTextEditor = { document: { uri: vscode.Uri.file('/path/to/workspace-folder/active-file.txt') } };
			vscode.mockExtensionSettingReturnValue('openToTheRepoOfTheActiveTextEditorDocument', true);
			vi.spyOn(repoManager, 'getRepoContainingFile').mockReturnValueOnce('/path/to/workspace-folder');

			// Run
			vscode.commands.executeCommand('git-graph.view');

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.view');
				expect(spyOnGitGraphViewCreateOrShow).toHaveBeenCalledWith('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, { repo: '/path/to/workspace-folder' });
			});
		});
	});

	describe('git-graph.addGitRepository', () => {
		let spyOnIsPathInWorkspace: MockInstance;
		beforeAll(() => {
			spyOnIsPathInWorkspace = vi.spyOn(utils, 'isPathInWorkspace');
		});

		it('Should register the selected repository', async () => {
			// Setup
			vscode.window.showOpenDialog.mockResolvedValueOnce([vscode.Uri.file('/path/to/workspace-folder/repo')]);
			spyOnIsPathInWorkspace.mockReturnValueOnce(true);
			spyOnRegisterRepo.mockResolvedValueOnce({ root: '/path/to/workspace-folder/repo', error: null });
			vscode.window.showInformationMessage.mockResolvedValueOnce(null);

			// Run
			vscode.commands.executeCommand('git-graph.addGitRepository');

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.addGitRepository');
				expect(vscode.window.showOpenDialog).toHaveBeenCalledWith({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false });
				expect(spyOnIsPathInWorkspace).toHaveBeenCalledWith('/path/to/workspace-folder/repo');
				expect(spyOnRegisterRepo).toHaveBeenCalledWith('/path/to/workspace-folder/repo', false);
				expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('The repository "/path/to/workspace-folder/repo" was added to Git Graph.');
			});
		});

		it('Should display the error message returned when registering the selected repository', async () => {
			// Setup
			vscode.window.showOpenDialog.mockResolvedValueOnce([vscode.Uri.file('/path/to/workspace-folder/repo')]);
			spyOnIsPathInWorkspace.mockReturnValueOnce(true);
			spyOnRegisterRepo.mockResolvedValueOnce({ root: null, error: 'The folder "/path/to/workspace-folder/repo" is not a Git repository.' });
			vscode.window.showErrorMessage.mockResolvedValueOnce(null);

			// Run
			vscode.commands.executeCommand('git-graph.addGitRepository');

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.addGitRepository');
				expect(vscode.window.showOpenDialog).toHaveBeenCalledWith({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false });
				expect(spyOnIsPathInWorkspace).toHaveBeenCalledWith('/path/to/workspace-folder/repo');
				expect(spyOnRegisterRepo).toHaveBeenCalledWith('/path/to/workspace-folder/repo', false);
				expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('The folder "/path/to/workspace-folder/repo" is not a Git repository. Therefore it could not be added to Git Graph.');
			});
		});

		it('Should display an error message when the selected repository is not within the workspace', async () => {
			// Setup
			vscode.window.showOpenDialog.mockResolvedValueOnce([vscode.Uri.file('/path/to/non-workspace-folder/repo')]);
			spyOnIsPathInWorkspace.mockReturnValueOnce(false);
			vscode.window.showErrorMessage.mockResolvedValueOnce(null);

			// Run
			vscode.commands.executeCommand('git-graph.addGitRepository');

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.addGitRepository');
				expect(vscode.window.showOpenDialog).toHaveBeenCalledWith({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false });
				expect(spyOnIsPathInWorkspace).toHaveBeenCalledWith('/path/to/non-workspace-folder/repo');
				expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
					'The folder "/path/to/non-workspace-folder/repo" is not within the opened Visual Studio Code workspace, and therefore could not be added to Git Graph.'
				);
				expect(spyOnRegisterRepo).not.toHaveBeenCalled();
			});
		});

		it('Should not proceed to register a repository when none was selected', async () => {
			// Setup
			vscode.window.showOpenDialog.mockResolvedValueOnce([]);

			// Run
			vscode.commands.executeCommand('git-graph.addGitRepository');

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.addGitRepository');
				expect(vscode.window.showOpenDialog).toHaveBeenCalledWith({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false });
				expect(spyOnIsPathInWorkspace).not.toHaveBeenCalled();
			});
		});

		it('Should handle if showOpenDialog rejects', async () => {
			// Setup
			vscode.window.showOpenDialog.mockRejectedValueOnce(null);

			// Run
			vscode.commands.executeCommand('git-graph.addGitRepository');

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.addGitRepository');
				expect(vscode.window.showOpenDialog).toHaveBeenCalledWith({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false });
				expect(spyOnIsPathInWorkspace).not.toHaveBeenCalled();
			});
		});

		it('Should display an error message if no git executable is known', async () => {
			// Setup
			commandManager['gitExecutable'] = null;
			vscode.window.showErrorMessage.mockResolvedValueOnce(null);

			// Run
			vscode.commands.executeCommand('git-graph.addGitRepository');

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.addGitRepository');
				expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(utils.UNABLE_TO_FIND_GIT_MSG);
			});
		});
	});

	describe('git-graph.removeGitRepository', () => {
		let spyOnIgnoreRepo: MockInstance;
		beforeAll(() => {
			spyOnIgnoreRepo = vi.spyOn(repoManager, 'ignoreRepo');
		});

		it('Should ignore the selected repository', async () => {
			// Setup
			const repos = {
				'/path/to/repo2': mockRepoState({ name: 'Custom Name', workspaceFolderIndex: 1 }),
				'/path/to/repo1': mockRepoState({ name: null, workspaceFolderIndex: 0 })
			};
			spyOnGetRepos.mockReturnValueOnce(repos);
			vscode.window.showQuickPick.mockResolvedValueOnce({
				label: 'repo1',
				description: '/path/to/repo1'
			});
			spyOnIgnoreRepo.mockReturnValueOnce(true);
			vscode.window.showInformationMessage.mockResolvedValueOnce(null);
			const spyOnGetSortedRepositoryPaths = vi.spyOn(utils, 'getSortedRepositoryPaths');

			// Run
			vscode.commands.executeCommand('git-graph.removeGitRepository');

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.removeGitRepository');
				expect(spyOnGetSortedRepositoryPaths).toHaveBeenCalledWith(repos, RepoDropdownOrder.WorkspaceFullPath);
				expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
					[
						{
							label: 'repo1',
							description: '/path/to/repo1'
						},
						{
							label: 'Custom Name',
							description: '/path/to/repo2'
						}
					],
					{
						placeHolder: 'Select a repository to remove from Git Graph:',
						canPickMany: false
					}
				);
				expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('The repository "repo1" was removed from Git Graph.');
			});
		});

		it('Should display an error message if the selected repository no longer exists', async () => {
			// Setup
			spyOnGetRepos.mockReturnValueOnce({
				'/path/to/repo1': mockRepoState({ name: null, workspaceFolderIndex: 0 }),
				'/path/to/repo2': mockRepoState({ name: 'Custom Name', workspaceFolderIndex: 0 })
			});
			vscode.window.showQuickPick.mockResolvedValueOnce({
				label: 'repo1',
				description: '/path/to/repo1'
			});
			spyOnIgnoreRepo.mockReturnValueOnce(false);
			vscode.window.showErrorMessage.mockResolvedValueOnce(null);

			// Run
			vscode.commands.executeCommand('git-graph.removeGitRepository');

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.removeGitRepository');
				expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
					[
						{
							label: 'repo1',
							description: '/path/to/repo1'
						},
						{
							label: 'Custom Name',
							description: '/path/to/repo2'
						}
					],
					{
						placeHolder: 'Select a repository to remove from Git Graph:',
						canPickMany: false
					}
				);
				expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('The repository "repo1" is not known to Git Graph.');
			});
		});

		it("Shouldn't attempt to ignore a repository if none was selected", async () => {
			// Setup
			spyOnGetRepos.mockReturnValueOnce({
				'/path/to/repo1': mockRepoState({ name: null, workspaceFolderIndex: 0 }),
				'/path/to/repo2': mockRepoState({ name: 'Custom Name', workspaceFolderIndex: 0 })
			});
			vscode.window.showQuickPick.mockResolvedValueOnce(null);

			// Run
			vscode.commands.executeCommand('git-graph.removeGitRepository');

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.removeGitRepository');
				expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
					[
						{
							label: 'repo1',
							description: '/path/to/repo1'
						},
						{
							label: 'Custom Name',
							description: '/path/to/repo2'
						}
					],
					{
						placeHolder: 'Select a repository to remove from Git Graph:',
						canPickMany: false
					}
				);
				expect(spyOnIgnoreRepo).not.toHaveBeenCalled();
			});
		});

		it('Should handle if showQuickPick rejects', async () => {
			// Setup
			spyOnGetRepos.mockReturnValueOnce({
				'/path/to/repo1': mockRepoState({ name: null, workspaceFolderIndex: 0 }),
				'/path/to/repo2': mockRepoState({ name: 'Custom Name', workspaceFolderIndex: 0 })
			});
			vscode.window.showQuickPick.mockRejectedValueOnce(null);

			// Run
			vscode.commands.executeCommand('git-graph.removeGitRepository');

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.removeGitRepository');
				expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
					[
						{
							label: 'repo1',
							description: '/path/to/repo1'
						},
						{
							label: 'Custom Name',
							description: '/path/to/repo2'
						}
					],
					{
						placeHolder: 'Select a repository to remove from Git Graph:',
						canPickMany: false
					}
				);
			});
		});

		it('Should display an error message if no git executable is known', async () => {
			// Setup
			commandManager['gitExecutable'] = null;
			vscode.window.showErrorMessage.mockResolvedValueOnce(null);

			// Run
			vscode.commands.executeCommand('git-graph.removeGitRepository');

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.removeGitRepository');
				expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(utils.UNABLE_TO_FIND_GIT_MSG);
			});
		});
	});

	describe('git-graph.clearAvatarCache', () => {
		let spyOnClearCache: MockInstance;
		beforeAll(() => {
			spyOnClearCache = vi.spyOn(avatarManager, 'clearCache');
		});

		it('Should clear the avatar cache, and display a success message', async () => {
			// Setup
			spyOnClearCache.mockResolvedValueOnce(null);
			vscode.window.showInformationMessage.mockResolvedValueOnce(null);

			// Run
			vscode.commands.executeCommand('git-graph.clearAvatarCache');

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.clearAvatarCache');
				expect(spyOnClearCache).toBeCalledTimes(1);
				expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('The Avatar Cache was successfully cleared.');
			});
		});

		it('Should display the error message returned by AvatarManager.clearCache', async () => {
			// Setup
			const errorMessage = 'Visual Studio Code was unable to save the Git Graph Global State Memento.';
			spyOnClearCache.mockResolvedValueOnce(errorMessage);
			vscode.window.showErrorMessage.mockResolvedValueOnce(null);

			// Run
			vscode.commands.executeCommand('git-graph.clearAvatarCache');

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.clearAvatarCache');
				expect(spyOnClearCache).toBeCalledTimes(1);
				expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(errorMessage);
			});
		});

		it('Should display an error message when AvatarManager.clearCache rejects', async () => {
			// Setup
			spyOnClearCache.mockRejectedValueOnce(null);
			vscode.window.showErrorMessage.mockResolvedValueOnce(null);

			// Run
			vscode.commands.executeCommand('git-graph.clearAvatarCache');

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.clearAvatarCache');
				expect(spyOnClearCache).toBeCalledTimes(1);
				expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('An unexpected error occurred while running the command "Clear Avatar Cache".');
			});
		});
	});

	describe('git-graph.fetch', () => {
		let spyOnGetLastActiveRepo: MockInstance;
		beforeAll(() => {
			spyOnGetLastActiveRepo = vi.spyOn(extensionState, 'getLastActiveRepo');
		});

		it('Should display a quick pick to select a repository to open in the Git Graph View (with last active repository first)', async () => {
			// Setup
			const repos = {
				'/path/to/repo3': mockRepoState({ name: null, workspaceFolderIndex: 2 }),
				'/path/to/repo2': mockRepoState({ name: 'Custom Name', workspaceFolderIndex: 1 }),
				'/path/to/repo1': mockRepoState({ name: null, workspaceFolderIndex: 0 })
			};
			spyOnGetRepos.mockReturnValueOnce(repos);
			spyOnGetLastActiveRepo.mockReturnValueOnce('/path/to/repo2');
			vscode.window.showQuickPick.mockResolvedValueOnce({
				label: 'repo1',
				description: '/path/to/repo1'
			});
			const spyOnGetSortedRepositoryPaths = vi.spyOn(utils, 'getSortedRepositoryPaths');

			// Run
			vscode.commands.executeCommand('git-graph.fetch');

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.fetch');
				expect(spyOnGetSortedRepositoryPaths).toHaveBeenCalledWith(repos, RepoDropdownOrder.WorkspaceFullPath);
				expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
					[
						{
							label: 'Custom Name',
							description: '/path/to/repo2'
						},
						{
							label: 'repo1',
							description: '/path/to/repo1'
						},
						{
							label: 'repo3',
							description: '/path/to/repo3'
						}
					],
					{
						placeHolder: 'Select the repository you want to open in Git Graph, and fetch from remote(s):',
						canPickMany: false
					}
				);
				expect(spyOnGitGraphViewCreateOrShow).toHaveBeenCalledWith('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, {
					repo: '/path/to/repo1',
					runCommandOnLoad: 'fetch'
				});
			});
		});

		it('Should display a quick pick to select a repository to open in the Git Graph View (no last active repository)', async () => {
			// Setup
			spyOnGetRepos.mockReturnValueOnce({
				'/path/to/repo1': mockRepoState({ name: null, workspaceFolderIndex: 0 }),
				'/path/to/repo2': mockRepoState({ name: 'Custom Name', workspaceFolderIndex: 0 })
			});
			spyOnGetLastActiveRepo.mockReturnValueOnce(null);
			vscode.window.showQuickPick.mockResolvedValueOnce({
				label: 'repo1',
				description: '/path/to/repo1'
			});

			// Run
			vscode.commands.executeCommand('git-graph.fetch');

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.fetch');
				expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
					[
						{
							label: 'repo1',
							description: '/path/to/repo1'
						},
						{
							label: 'Custom Name',
							description: '/path/to/repo2'
						}
					],
					{
						placeHolder: 'Select the repository you want to open in Git Graph, and fetch from remote(s):',
						canPickMany: false
					}
				);
				expect(spyOnGitGraphViewCreateOrShow).toHaveBeenCalledWith('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, {
					repo: '/path/to/repo1',
					runCommandOnLoad: 'fetch'
				});
			});
		});

		it('Should display a quick pick to select a repository to open in the Git Graph View (last active repository is unknown)', async () => {
			// Setup
			spyOnGetRepos.mockReturnValueOnce({
				'/path/to/repo1': mockRepoState({ name: null, workspaceFolderIndex: 0 }),
				'/path/to/repo2': mockRepoState({ name: 'Custom Name', workspaceFolderIndex: 0 })
			});
			spyOnGetLastActiveRepo.mockReturnValueOnce('/path/to/repo3');
			vscode.window.showQuickPick.mockResolvedValueOnce({
				label: 'repo1',
				description: '/path/to/repo1'
			});

			// Run
			vscode.commands.executeCommand('git-graph.fetch');

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.fetch');
				expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
					[
						{
							label: 'repo1',
							description: '/path/to/repo1'
						},
						{
							label: 'Custom Name',
							description: '/path/to/repo2'
						}
					],
					{
						placeHolder: 'Select the repository you want to open in Git Graph, and fetch from remote(s):',
						canPickMany: false
					}
				);
				expect(spyOnGitGraphViewCreateOrShow).toHaveBeenCalledWith('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, {
					repo: '/path/to/repo1',
					runCommandOnLoad: 'fetch'
				});
			});
		});

		it("Shouldn't open the Git Graph View when no item is selected in the quick pick", async () => {
			// Setup
			spyOnGetRepos.mockReturnValueOnce({
				'/path/to/repo1': mockRepoState({ name: null, workspaceFolderIndex: 0 }),
				'/path/to/repo2': mockRepoState({ name: 'Custom Name', workspaceFolderIndex: 0 })
			});
			spyOnGetLastActiveRepo.mockReturnValueOnce('/path/to/repo3');
			vscode.window.showQuickPick.mockResolvedValueOnce(null);

			// Run
			vscode.commands.executeCommand('git-graph.fetch');

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.fetch');
				expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
					[
						{
							label: 'repo1',
							description: '/path/to/repo1'
						},
						{
							label: 'Custom Name',
							description: '/path/to/repo2'
						}
					],
					{
						placeHolder: 'Select the repository you want to open in Git Graph, and fetch from remote(s):',
						canPickMany: false
					}
				);
				expect(spyOnGitGraphViewCreateOrShow).not.toHaveBeenCalled();
			});
		});

		it('Should display an error message when showQuickPick rejects', async () => {
			// Setup
			spyOnGetRepos.mockReturnValueOnce({
				'/path/to/repo1': mockRepoState({ name: null, workspaceFolderIndex: 0 }),
				'/path/to/repo2': mockRepoState({ name: 'Custom Name', workspaceFolderIndex: 0 })
			});
			spyOnGetLastActiveRepo.mockReturnValueOnce('/path/to/repo2');
			vscode.window.showQuickPick.mockRejectedValueOnce(null);
			vscode.window.showErrorMessage.mockResolvedValueOnce(null);

			// Run
			vscode.commands.executeCommand('git-graph.fetch');

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.fetch');
				expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
					[
						{
							label: 'Custom Name',
							description: '/path/to/repo2'
						},
						{
							label: 'repo1',
							description: '/path/to/repo1'
						}
					],
					{
						placeHolder: 'Select the repository you want to open in Git Graph, and fetch from remote(s):',
						canPickMany: false
					}
				);
				expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('An unexpected error occurred while running the command "Fetch from Remote(s)".');
				expect(spyOnGitGraphViewCreateOrShow).not.toHaveBeenCalled();
			});
		});

		it('Should open the Git Graph View immediately when there is only one repository', async () => {
			// Setup
			spyOnGetRepos.mockReturnValueOnce({
				'/path/to/repo1': mockRepoState({ name: null, workspaceFolderIndex: 0 })
			});

			// Run
			vscode.commands.executeCommand('git-graph.fetch');

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.fetch');
				expect(spyOnGitGraphViewCreateOrShow).toHaveBeenCalledWith('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, {
					repo: '/path/to/repo1',
					runCommandOnLoad: 'fetch'
				});
			});
		});

		it('Should open the Git Graph View immediately when there are no repositories', async () => {
			// Setup
			spyOnGetRepos.mockReturnValueOnce({});

			// Run
			vscode.commands.executeCommand('git-graph.fetch');

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.fetch');
				expect(spyOnGitGraphViewCreateOrShow).toHaveBeenCalledWith('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);
			});
		});
	});

	describe('git-graph.endAllWorkspaceCodeReviews', () => {
		it('Should end all workspace code reviews', () => {
			// Setup
			const spyOnEndAllWorkspaceCodeReviews = vi.spyOn(extensionState, 'endAllWorkspaceCodeReviews');
			vscode.window.showInformationMessage.mockResolvedValueOnce(null);

			// Run
			vscode.commands.executeCommand('git-graph.endAllWorkspaceCodeReviews');

			// Assert
			expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.endAllWorkspaceCodeReviews');
			expect(spyOnEndAllWorkspaceCodeReviews).toBeCalledTimes(1);
			expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Ended All Code Reviews in Workspace');
		});
	});

	describe('git-graph.endSpecificWorkspaceCodeReview', () => {
		it('Should end the selected code review', async () => {
			// Setup
			spyOnGetCodeReviews.mockReturnValueOnce({
				'/path/to/repo': {
					'1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b': {
						lastActive: (date.now - 5) * 1000,
						lastViewedFile: null,
						remainingFiles: ['file.txt']
					}
				}
			});
			spyOnGetRepos.mockReturnValueOnce({
				'/path/to/repo': mockRepoState({ name: null, workspaceFolderIndex: 0 })
			});
			spyOnGetCommitSubject.mockResolvedValueOnce('Commit Subject');
			vscode.window.showQuickPick.mockImplementationOnce((items: Promise<any[]>, _: any) => items.then((items) => items[0]));
			spyOnEndCodeReview.mockResolvedValueOnce(null);
			vscode.window.showInformationMessage.mockResolvedValueOnce(null);

			// Run
			vscode.commands.executeCommand('git-graph.endSpecificWorkspaceCodeReview');

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.endSpecificWorkspaceCodeReview');
				expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Successfully ended Code Review "repo: 1a2b3c4d".');
			});
			expect(spyOnGetCommitSubject).toHaveBeenCalledWith('/path/to/repo', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b');
			expect(spyOnEndCodeReview).toHaveBeenCalledWith('/path/to/repo', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b');
			expect(await vscode.window.showQuickPick.mock.calls[0][0]).toStrictEqual([
				{
					codeReviewRepo: '/path/to/repo',
					codeReviewId: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					label: 'repo: 1a2b3c4d',
					description: '5 seconds ago',
					detail: 'Commit Subject'
				}
			]);
			expect(vscode.window.showQuickPick.mock.calls[0][1]).toStrictEqual({
				placeHolder: 'Select the Code Review you want to end:',
				canPickMany: false
			});
		});

		it('Should display an error message when there are no code reviews', () => {
			// Setup
			spyOnGetCodeReviews.mockReturnValueOnce({});
			vscode.window.showErrorMessage.mockResolvedValueOnce(null);

			// Run
			vscode.commands.executeCommand('git-graph.endSpecificWorkspaceCodeReview');

			// Assert
			expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.endSpecificWorkspaceCodeReview');
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('There are no Code Reviews in progress within the current workspace.');
			expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
		});

		it("Shouldn't end a code review if no code review was selected", async () => {
			// Setup
			spyOnGetCodeReviews.mockReturnValueOnce({
				'/path/to/repo': {
					'1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b': {
						lastActive: (date.now - 5) * 1000,
						lastViewedFile: null,
						remainingFiles: ['file.txt']
					}
				}
			});
			spyOnGetRepos.mockReturnValueOnce({
				'/path/to/repo': mockRepoState({ name: null, workspaceFolderIndex: 0 })
			});
			spyOnGetCommitSubject.mockResolvedValueOnce('Commit Subject');
			vscode.window.showQuickPick.mockResolvedValueOnce(null);

			// Run
			vscode.commands.executeCommand('git-graph.endSpecificWorkspaceCodeReview');

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.endSpecificWorkspaceCodeReview');
				expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(1);
				expect(spyOnEndCodeReview).not.toHaveBeenCalled();
			});
		});

		it('Should handle endCodeReview rejecting', async () => {
			// Setup
			spyOnGetCodeReviews.mockReturnValueOnce({
				'/path/to/repo': {
					'1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b': {
						lastActive: (date.now - 5) * 1000,
						lastViewedFile: null,
						remainingFiles: ['file.txt']
					}
				}
			});
			spyOnGetRepos.mockReturnValueOnce({
				'/path/to/repo': mockRepoState({ name: null, workspaceFolderIndex: 0 })
			});
			spyOnGetCommitSubject.mockResolvedValueOnce('Commit Subject');
			vscode.window.showQuickPick.mockImplementationOnce((items: Promise<any[]>, _: any) => items.then((items) => items[0]));
			spyOnEndCodeReview.mockRejectedValueOnce(null);

			// Run
			vscode.commands.executeCommand('git-graph.endSpecificWorkspaceCodeReview');

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.endSpecificWorkspaceCodeReview');
				expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(1);
				expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
				expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
			});
		});

		it("Should display an error message when the code review couldn't be ended", async () => {
			// Setup
			spyOnGetCodeReviews.mockReturnValueOnce({
				'/path/to/repo': {
					'1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b': {
						lastActive: (date.now - 5) * 1000,
						lastViewedFile: null,
						remainingFiles: ['file.txt']
					}
				}
			});
			spyOnGetRepos.mockReturnValueOnce({
				'/path/to/repo': mockRepoState({ name: null, workspaceFolderIndex: 0 })
			});
			spyOnGetCommitSubject.mockResolvedValueOnce('Commit Subject');
			vscode.window.showQuickPick.mockImplementationOnce((items: Promise<any[]>, _: any) => items.then((items) => items[0]));
			spyOnEndCodeReview.mockResolvedValueOnce('Visual Studio Code was unable to save the Git Graph Workspace State Memento.');
			vscode.window.showErrorMessage.mockResolvedValueOnce(null);

			// Run
			vscode.commands.executeCommand('git-graph.endSpecificWorkspaceCodeReview');

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.endSpecificWorkspaceCodeReview');
				expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Visual Studio Code was unable to save the Git Graph Workspace State Memento.');
			});
		});

		it('Should display an error message when showQuickPick rejects', async () => {
			// Setup
			spyOnGetCodeReviews.mockReturnValueOnce({
				'/path/to/repo': {
					'1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b': {
						lastActive: (date.now - 5) * 1000,
						lastViewedFile: null,
						remainingFiles: ['file.txt']
					}
				}
			});
			spyOnGetRepos.mockReturnValueOnce({
				'/path/to/repo': mockRepoState({ name: null, workspaceFolderIndex: 0 })
			});
			spyOnGetCommitSubject.mockResolvedValueOnce('Commit Subject');
			vscode.window.showQuickPick.mockRejectedValueOnce(null);
			vscode.window.showErrorMessage.mockResolvedValueOnce(null);

			// Run
			vscode.commands.executeCommand('git-graph.endSpecificWorkspaceCodeReview');

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.endSpecificWorkspaceCodeReview');
				expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('An unexpected error occurred while running the command "End a specific Code Review in Workspace...".');
			});
		});
	});

	describe('git-graph.resumeWorkspaceCodeReview', () => {
		it('Should load the selected code review in the Git Graph View (single commit)', async () => {
			// Setup
			spyOnGetCodeReviews.mockReturnValueOnce({
				'/path/to/repo': {
					'1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b': {
						lastActive: (date.now - 10) * 1000,
						lastViewedFile: null,
						remainingFiles: ['file.txt']
					},
					'2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c': {
						lastActive: (date.now - 5) * 1000,
						lastViewedFile: null,
						remainingFiles: ['file.txt']
					}
				},
				'/path/to/unknown-repo': {
					'1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b': {
						lastActive: (date.now - 10) * 1000,
						lastViewedFile: null,
						remainingFiles: ['file.txt']
					}
				}
			});
			spyOnGetRepos.mockReturnValueOnce({
				'/path/to/repo': mockRepoState({ name: null, workspaceFolderIndex: 0 })
			});
			spyOnGetCommitSubject.mockImplementationOnce((_: string, hash: string) => (hash === '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b' ? 'subject-' + hash : null));
			spyOnGetCommitSubject.mockImplementationOnce((_: string, hash: string) => (hash === '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b' ? 'subject-' + hash : null));
			vscode.window.showQuickPick.mockImplementationOnce((items: Promise<any[]>, _: any) => items.then((items) => items[0]));

			// Run
			vscode.commands.executeCommand('git-graph.resumeWorkspaceCodeReview');

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.resumeWorkspaceCodeReview');
				expect(spyOnGitGraphViewCreateOrShow).toHaveBeenCalledWith('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, {
					repo: '/path/to/repo',
					commitDetails: {
						commitHash: '2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c',
						compareWithHash: null
					}
				});
			});
			expect(spyOnGetCommitSubject).toHaveBeenCalledTimes(2);
			expect(spyOnGetCommitSubject).toHaveBeenCalledWith('/path/to/repo', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b');
			expect(spyOnGetCommitSubject).toHaveBeenCalledWith('/path/to/repo', '2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c');
			expect(await vscode.window.showQuickPick.mock.calls[0][0]).toStrictEqual([
				{
					codeReviewRepo: '/path/to/repo',
					codeReviewId: '2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c',
					label: 'repo: 2b3c4d5e',
					description: '5 seconds ago',
					detail: '<Unknown Commit Subject>'
				},
				{
					codeReviewRepo: '/path/to/repo',
					codeReviewId: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					label: 'repo: 1a2b3c4d',
					description: '10 seconds ago',
					detail: 'subject-1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b'
				}
			]);
			expect(vscode.window.showQuickPick.mock.calls[0][1]).toStrictEqual({
				placeHolder: 'Select the Code Review you want to resume:',
				canPickMany: false
			});
		});

		it('Should load the selected code review in the Git Graph View (commit comparison)', async () => {
			// Setup
			spyOnGetCodeReviews.mockReturnValueOnce({
				'/path/to/repo': {
					'1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b-2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c': {
						lastActive: (date.now - 5) * 1000,
						lastViewedFile: null,
						remainingFiles: ['file.txt']
					}
				}
			});
			spyOnGetRepos.mockReturnValueOnce({
				'/path/to/repo': mockRepoState({ name: null, workspaceFolderIndex: 0 })
			});
			spyOnGetCommitSubject.mockImplementationOnce((_: string, hash: string) => 'subject-' + hash);
			spyOnGetCommitSubject.mockImplementationOnce((_: string, hash: string) => 'subject-' + hash);
			vscode.window.showQuickPick.mockImplementationOnce((items: Promise<any[]>, _: any) => items.then((items) => items[0]));

			// Run
			vscode.commands.executeCommand('git-graph.resumeWorkspaceCodeReview');

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.resumeWorkspaceCodeReview');
				expect(spyOnGitGraphViewCreateOrShow).toHaveBeenCalledWith('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, {
					repo: '/path/to/repo',
					commitDetails: {
						commitHash: '2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c',
						compareWithHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b'
					}
				});
			});
			expect(await vscode.window.showQuickPick.mock.calls[0][0]).toStrictEqual([
				{
					codeReviewRepo: '/path/to/repo',
					codeReviewId: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b-2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c',
					label: 'repo: 1a2b3c4d ↔ 2b3c4d5e',
					description: '5 seconds ago',
					detail: 'subject-1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b ↔ subject-2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c'
				}
			]);
			expect(vscode.window.showQuickPick.mock.calls[0][1]).toStrictEqual({
				placeHolder: 'Select the Code Review you want to resume:',
				canPickMany: false
			});
		});

		it("Shouldn't load the the Git Graph View if no code review was selected", async () => {
			// Setup
			spyOnGetCodeReviews.mockReturnValueOnce({
				'/path/to/repo': {
					'1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b': {
						lastActive: (date.now - 5) * 1000,
						lastViewedFile: null,
						remainingFiles: ['file.txt']
					}
				}
			});
			spyOnGetRepos.mockReturnValueOnce({
				'/path/to/repo': mockRepoState({ name: null, workspaceFolderIndex: 0 })
			});
			spyOnGetCommitSubject.mockResolvedValueOnce('Commit Subject');
			vscode.window.showQuickPick.mockResolvedValueOnce(null);

			// Run
			vscode.commands.executeCommand('git-graph.resumeWorkspaceCodeReview');

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.resumeWorkspaceCodeReview');
				expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(1);
				expect(spyOnGitGraphViewCreateOrShow).not.toHaveBeenCalled();
			});
		});

		it('Should display an error message when there are no code reviews', () => {
			// Setup
			spyOnGetCodeReviews.mockReturnValueOnce({});
			vscode.window.showErrorMessage.mockResolvedValueOnce(null);

			// Run
			vscode.commands.executeCommand('git-graph.resumeWorkspaceCodeReview');

			// Assert
			expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.resumeWorkspaceCodeReview');
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('There are no Code Reviews in progress within the current workspace.');
			expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
		});

		it('Should display an error message when showQuickPick rejects', async () => {
			// Setup
			spyOnGetCodeReviews.mockReturnValueOnce({
				'/path/to/repo': {
					'1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b': {
						lastActive: (date.now - 5) * 1000,
						lastViewedFile: null,
						remainingFiles: ['file.txt']
					}
				}
			});
			spyOnGetRepos.mockReturnValueOnce({
				'/path/to/repo': mockRepoState({ name: null, workspaceFolderIndex: 0 })
			});
			spyOnGetCommitSubject.mockResolvedValueOnce('Commit Subject');
			vscode.window.showQuickPick.mockRejectedValueOnce(null);
			vscode.window.showErrorMessage.mockResolvedValueOnce(null);

			// Run
			vscode.commands.executeCommand('git-graph.resumeWorkspaceCodeReview');

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.resumeWorkspaceCodeReview');
				expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('An unexpected error occurred while running the command "Resume a specific Code Review in Workspace...".');
			});
		});
	});

	describe('git-graph.version', () => {
		let spyOnCopyToClipboard: MockInstance, spyOnGetExtensionVersion: MockInstance, spyOnOsType: MockInstance, spyOnOsArch: MockInstance, spyOnOsRelease: MockInstance;
		beforeAll(() => {
			spyOnCopyToClipboard = vi.spyOn(utils, 'copyToClipboard');
			spyOnGetExtensionVersion = vi.spyOn(utils, 'getExtensionVersion');
			spyOnOsType = vi.spyOn(os, 'type');
			spyOnOsArch = vi.spyOn(os, 'arch');
			spyOnOsRelease = vi.spyOn(os, 'release');
		});

		it('Should display the version information, and copy it to the clipboard', async () => {
			// Setup
			spyOnGetExtensionVersion.mockResolvedValueOnce('1.27.0');
			vscode.window.showInformationMessage.mockResolvedValueOnce('Copy');
			spyOnCopyToClipboard.mockResolvedValueOnce(null);
			spyOnOsType.mockReturnValueOnce('X');
			spyOnOsArch.mockReturnValueOnce('Y');
			spyOnOsRelease.mockReturnValueOnce('Z');

			// Run
			vscode.commands.executeCommand('git-graph.version');

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.version');
				expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Git Graph: 1.27.0\nVisual Studio Code: 1.51.0\nOS: X Y Z\nGit: 2.25.0', { modal: true }, 'Copy');
				expect(spyOnCopyToClipboard).toHaveBeenCalledWith('Git Graph: 1.27.0\nVisual Studio Code: 1.51.0\nOS: X Y Z\nGit: 2.25.0');
			});
		});

		it("Shouldn't copy the version information to the clipboard if the user closes the information message modal", async () => {
			// Setup
			commandManager['gitExecutable'] = null;
			spyOnGetExtensionVersion.mockResolvedValueOnce('1.27.0');
			vscode.window.showInformationMessage.mockResolvedValueOnce('');
			spyOnOsType.mockReturnValueOnce('X');
			spyOnOsArch.mockReturnValueOnce('Y');
			spyOnOsRelease.mockReturnValueOnce('Z');

			// Run
			vscode.commands.executeCommand('git-graph.version');

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.version');
				expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Git Graph: 1.27.0\nVisual Studio Code: 1.51.0\nOS: X Y Z\nGit: (none)', { modal: true }, 'Copy');
				expect(spyOnCopyToClipboard).not.toHaveBeenCalled();
			});
		});

		it("Should display an error message when the extension version couldn't be retrieved", async () => {
			// Setup
			spyOnGetExtensionVersion.mockRejectedValueOnce(null);
			vscode.window.showErrorMessage.mockResolvedValueOnce(null);

			// Run
			vscode.commands.executeCommand('git-graph.version');

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.version');
				expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('An unexpected error occurred while retrieving version information.');
			});
		});

		it("Should display an error message when the version information couldn't be copied to the clipboard", async () => {
			// Setup
			spyOnGetExtensionVersion.mockResolvedValueOnce('1.27.0');
			vscode.window.showInformationMessage.mockResolvedValueOnce('Copy');
			vscode.window.showErrorMessage.mockResolvedValueOnce(null);
			spyOnCopyToClipboard.mockResolvedValueOnce('error message');
			spyOnOsType.mockReturnValueOnce('X');
			spyOnOsArch.mockReturnValueOnce('Y');
			spyOnOsRelease.mockReturnValueOnce('Z');

			// Run
			vscode.commands.executeCommand('git-graph.version');

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.version');
				expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Git Graph: 1.27.0\nVisual Studio Code: 1.51.0\nOS: X Y Z\nGit: 2.25.0', { modal: true }, 'Copy');
				expect(spyOnCopyToClipboard).toHaveBeenCalledWith('Git Graph: 1.27.0\nVisual Studio Code: 1.51.0\nOS: X Y Z\nGit: 2.25.0');
				expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('error message');
			});
		});

		it('Should handle if showInformationMessage rejects', async () => {
			// Setup
			spyOnGetExtensionVersion.mockResolvedValueOnce('1.27.0');
			vscode.window.showInformationMessage.mockRejectedValueOnce(null);
			spyOnOsType.mockReturnValueOnce('X');
			spyOnOsArch.mockReturnValueOnce('Y');
			spyOnOsRelease.mockReturnValueOnce('Z');

			// Run
			vscode.commands.executeCommand('git-graph.version');

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.version');
				expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Git Graph: 1.27.0\nVisual Studio Code: 1.51.0\nOS: X Y Z\nGit: 2.25.0', { modal: true }, 'Copy');
				expect(spyOnCopyToClipboard).not.toHaveBeenCalled();
			});
		});
	});

	describe('git-graph.openFile', () => {
		let spyOnOpenFile: MockInstance;
		beforeAll(() => {
			spyOnOpenFile = vi.spyOn(utils, 'openFile');
		});

		it('Should open the provided file', async () => {
			spyOnOpenFile.mockResolvedValueOnce(null);

			// Run
			await vscode.commands.executeCommand(
				'git-graph.openFile',
				encodeDiffDocUri('/path/to/repo', 'subfolder/modified.txt', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', GitFileStatus.Modified, DiffSide.New)
			);

			// Assert
			expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.openFile');
			expect(spyOnOpenFile).toHaveBeenCalledWith('/path/to/repo', 'subfolder/modified.txt', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', dataSource, vscode.ViewColumn.Active);
		});

		it('Should open the file of the active text editor', async () => {
			vscode.window.activeTextEditor = {
				document: { uri: encodeDiffDocUri('/path/to/repo', 'subfolder/modified.txt', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', GitFileStatus.Modified, DiffSide.New) }
			};
			spyOnOpenFile.mockResolvedValueOnce(null);

			// Run
			await vscode.commands.executeCommand('git-graph.openFile');

			// Assert
			expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.openFile');
			expect(spyOnOpenFile).toHaveBeenCalledWith('/path/to/repo', 'subfolder/modified.txt', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', dataSource, vscode.ViewColumn.Active);
		});

		it('Should display an error message when no URI is provided', async () => {
			vscode.window.activeTextEditor = undefined;
			vscode.window.showErrorMessage.mockResolvedValueOnce(null);

			// Run
			await vscode.commands.executeCommand('git-graph.openFile');

			// Assert
			expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.openFile');
			expect(spyOnOpenFile).not.toHaveBeenCalled();
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Unable to Open File: The command was not called with the required arguments.');
		});

		it('Should display an error message when no Git Graph URI is provided', async () => {
			vscode.window.activeTextEditor = { document: { uri: vscode.Uri.file('/path/to/workspace-folder/active-file.txt') } };
			vscode.window.showErrorMessage.mockResolvedValueOnce(null);

			// Run
			await vscode.commands.executeCommand('git-graph.openFile');

			// Assert
			expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.openFile');
			expect(spyOnOpenFile).not.toHaveBeenCalled();
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Unable to Open File: The command was not called with the required arguments.');
		});

		it("Should display an error message when the file can't be opened", async () => {
			vscode.window.activeTextEditor = {
				document: { uri: encodeDiffDocUri('/path/to/repo', 'subfolder/modified.txt', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', GitFileStatus.Modified, DiffSide.New) }
			};
			spyOnOpenFile.mockResolvedValueOnce('Error Message');
			vscode.window.showErrorMessage.mockResolvedValueOnce(null);

			// Run
			await vscode.commands.executeCommand('git-graph.openFile');

			// Assert
			expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.openFile');
			expect(spyOnOpenFile).toHaveBeenCalledWith('/path/to/repo', 'subfolder/modified.txt', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', dataSource, vscode.ViewColumn.Active);
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Unable to Open File: Error Message');
		});
	});

	describe('git-graph.openWithPathFilter', () => {
		let spyOnGetRepoContainingFile: MockInstance;
		beforeAll(() => {
			spyOnGetRepoContainingFile = vi.spyOn(repoManager, 'getRepoContainingFile');
		});

		it('Should open the Git Graph View to the repository containing the file, filtered by the path of the file', async () => {
			// Setup
			spyOnGetRepos.mockReturnValueOnce({ '/path/to/repo': mockRepoState() });
			spyOnGetRepoContainingFile.mockReturnValueOnce('/path/to/repo');

			// Run
			await vscode.commands.executeCommand('git-graph.openWithPathFilter', vscode.Uri.file('/path/to/repo/subfolder/file.txt'));

			// Assert
			expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.openWithPathFilter');
			expect(spyOnGetRepoContainingFile).toHaveBeenCalledWith('/path/to/repo/subfolder/file.txt');
			expect(spyOnGitGraphViewCreateOrShow).toHaveBeenCalledWith('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, {
				repo: '/path/to/repo',
				pathFilter: 'subfolder/file.txt'
			});
		});

		it('Should open the Git Graph View to the repository without a path filter, when the root folder of the repository is selected', async () => {
			// Setup
			spyOnGetRepos.mockReturnValueOnce({ '/path/to/repo': mockRepoState() });

			// Run
			await vscode.commands.executeCommand('git-graph.openWithPathFilter', vscode.Uri.file('/path/to/repo'));

			// Assert
			expect(spyOnLog).toHaveBeenCalledWith('Command Invoked: git-graph.openWithPathFilter');
			expect(spyOnGetRepoContainingFile).not.toHaveBeenCalled();
			expect(spyOnGitGraphViewCreateOrShow).toHaveBeenCalledWith('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, {
				repo: '/path/to/repo',
				pathFilter: null
			});
		});

		it('Should display an error message when the file is not in a known repository', async () => {
			// Setup
			spyOnGetRepos.mockReturnValueOnce({ '/path/to/repo': mockRepoState() });
			spyOnGetRepoContainingFile.mockReturnValueOnce(null);
			vscode.window.showErrorMessage.mockResolvedValueOnce(null);

			// Run
			await vscode.commands.executeCommand('git-graph.openWithPathFilter', vscode.Uri.file('/path/to/other/file.txt'));

			// Assert
			expect(spyOnGitGraphViewCreateOrShow).not.toHaveBeenCalled();
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Unable to Filter in Git Graph: "/path/to/other/file.txt" is not in a repository known to Git Graph.');
		});

		it('Should display an error message when no URI is provided', async () => {
			// Setup
			vscode.window.showErrorMessage.mockResolvedValueOnce(null);

			// Run
			await vscode.commands.executeCommand('git-graph.openWithPathFilter');

			// Assert
			expect(spyOnGitGraphViewCreateOrShow).not.toHaveBeenCalled();
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Unable to Filter in Git Graph: The command was not called with the required arguments.');
		});
	});
});
