import type { Mock, MockInstance } from 'vite-plus/test';
import * as date from './mocks/date';
import * as vscode from './mocks/vscode';
vi.mock('../src/logger');

import { Logger } from '../src/logger';
import { RepoFileWatcher } from '../src/repoFileWatcher';

let logger: Logger;
let spyOnLog: MockInstance;

beforeAll(() => {
	logger = new Logger();
	spyOnLog = vi.spyOn(logger, 'log');
	vi.useFakeTimers();
});

afterAll(() => {
	logger.dispose();
});

describe('RepoFileWatcher', () => {
	let repoFileWatcher: RepoFileWatcher;
	let callback: Mock;
	beforeEach(() => {
		callback = vi.fn();
		repoFileWatcher = new RepoFileWatcher(logger, callback);
	});

	it('Should start and receive file events', () => {
		// Setup
		repoFileWatcher.start('/path/to/repo');
		const onDidCreate = (<Mock>repoFileWatcher['fsWatcher']!.onDidCreate).mock.calls[0][0];
		const onDidChange = (<Mock>repoFileWatcher['fsWatcher']!.onDidChange).mock.calls[0][0];
		const onDidDelete = (<Mock>repoFileWatcher['fsWatcher']!.onDidDelete).mock.calls[0][0];

		// Run
		onDidCreate(vscode.Uri.file('/path/to/repo/file'));
		onDidChange(vscode.Uri.file('/path/to/repo/file'));
		onDidDelete(vscode.Uri.file('/path/to/repo/file'));
		vi.runOnlyPendingTimers();

		// Assert
		expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalledWith('/path/to/repo/**');
		expect(callback).toHaveBeenCalledTimes(1);
	});

	it('Should stop a previous active File System Watcher before creating a new one', () => {
		// Setup
		repoFileWatcher.start('/path/to/repo1');
		const watcher = repoFileWatcher['fsWatcher']!;
		const onDidCreate = (<Mock>watcher.onDidCreate).mock.calls[0][0];

		// Run
		onDidCreate(vscode.Uri.file('/path/to/repo1/file'));
		repoFileWatcher.start('/path/to/repo2');
		vi.runOnlyPendingTimers();

		// Assert
		expect(<Mock>watcher.dispose).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenCalledTimes(0);
	});

	it('Should only dispose the active File System Watcher if it exists', () => {
		// Run
		repoFileWatcher.stop();

		// Assert
		expect(spyOnLog).toHaveBeenCalledTimes(0);
	});

	it('Should ignore file system events while muted', () => {
		// Setup
		repoFileWatcher.start('/path/to/repo');
		const onDidCreate = (<Mock>repoFileWatcher['fsWatcher']!.onDidCreate).mock.calls[0][0];

		// Run
		repoFileWatcher.mute();
		onDidCreate(vscode.Uri.file('/path/to/repo/file'));
		vi.runOnlyPendingTimers();

		// Assert
		expect(callback).toHaveBeenCalledTimes(0);
	});

	it('Should resume reporting file events after 1.5 seconds', () => {
		// Setup
		date.setCurrentTime(1587559258);
		repoFileWatcher.start('/path/to/repo');
		const onDidCreate = (<Mock>repoFileWatcher['fsWatcher']!.onDidCreate).mock.calls[0][0];
		const onDidChange = (<Mock>repoFileWatcher['fsWatcher']!.onDidChange).mock.calls[0][0];

		// Run
		repoFileWatcher.mute();
		repoFileWatcher.unmute();
		onDidCreate(vscode.Uri.file('/path/to/repo/file'));
		date.setCurrentTime(1587559260);
		onDidChange(vscode.Uri.file('/path/to/repo/file'));
		vi.runOnlyPendingTimers();

		// Assert
		expect(callback).toHaveBeenCalledTimes(1);
	});

	it('Should ignore file system events on files ignored within .git directory', () => {
		// Setup
		repoFileWatcher.start('/path/to/repo');
		const onDidCreate = (<Mock>repoFileWatcher['fsWatcher']!.onDidCreate).mock.calls[0][0];

		// Run
		onDidCreate(vscode.Uri.file('/path/to/repo/.git/config-x'));
		vi.runOnlyPendingTimers();

		// Assert
		expect(callback).toHaveBeenCalledTimes(0);
	});
});
