import type { GraphRow, Head, Remote, Tag } from '@gitkraken/gitkraken-components';
import { commitNodeType, mergeNodeType, stashNodeType } from '@gitkraken/gitkraken-components';
import type { ColorTheme, ConfigurationChangeEvent, Disposable, Event, StatusBarItem } from 'vscode';
import { ColorThemeKind, EventEmitter, MarkdownString, StatusBarAlignment, Uri, ViewColumn, window } from 'vscode';
import { parseCommandContext } from '../../../commands/base';
import { GitActions } from '../../../commands/gitCommands.actions';
import type { GraphColumnConfig } from '../../../configuration';
import { configuration } from '../../../configuration';
import { Commands } from '../../../constants';
import type { Container } from '../../../container';
import { emojify } from '../../../emojis';
import { Features } from '../../../features';
import type { GitBranch } from '../../../git/models/branch';
import { getBranchNameWithoutRemote, getRemoteNameFromBranchName } from '../../../git/models/branch';
import type { GitCommit } from '../../../git/models/commit';
import { isStash } from '../../../git/models/commit';
import type { GitLog } from '../../../git/models/log';
import type { GitRemote } from '../../../git/models/remote';
import type { Repository, RepositoryChangeEvent } from '../../../git/models/repository';
import { RepositoryChange, RepositoryChangeComparisonMode } from '../../../git/models/repository';
import type { GitStash } from '../../../git/models/stash';
import type { GitTag } from '../../../git/models/tag';
import { debug } from '../../../system/decorators/log';
import type { Deferrable } from '../../../system/function';
import { debounce } from '../../../system/function';
import { filterMap } from '../../../system/iterable';
import { updateRecordValue } from '../../../system/object';
import { getSettledValue } from '../../../system/promise';
import { RepositoryFolderNode } from '../../../views/nodes/viewNode';
import type { IpcMessage } from '../../../webviews/protocol';
import { onIpc } from '../../../webviews/protocol';
import { WebviewBase } from '../../../webviews/webviewBase';
import { ensurePlusFeaturesEnabled } from '../../subscription/utils';
import type { GraphCompositeConfig, GraphLog, GraphRepository, State } from './protocol';
import {
	DidChangeCommitsNotificationType,
	DidChangeGraphConfigurationNotificationType,
	DidChangeNotificationType,
	DismissPreviewCommandType,
	GetMoreCommitsCommandType,
	UpdateColumnCommandType,
	UpdateSelectedRepositoryCommandType,
	UpdateSelectionCommandType,
} from './protocol';

export interface GraphSelectionChangeEvent {
	readonly selection: GitCommit[];
}

export class GraphWebview extends WebviewBase<State> {
	private _onDidChangeSelection = new EventEmitter<GraphSelectionChangeEvent>();
	get onDidChangeSelection(): Event<GraphSelectionChangeEvent> {
		return this._onDidChangeSelection.event;
	}

	private _repository?: Repository;
	get repository(): Repository | undefined {
		return this._repository;
	}

	set repository(value: Repository | undefined) {
		if (this._repository === value) return;

		this._repositoryEventsDisposable?.dispose();
		this._repository = value;
		this._etagRepository = value?.etag;
		this._repositoryLog = undefined;

		if (value != null) {
			this._repositoryEventsDisposable = value.onDidChange(this.onRepositoryChanged, this);
		}

		this.updateState();
	}

	private _selection: readonly GitCommit[] | undefined;
	get selection(): readonly GitCommit[] | undefined {
		return this._selection;
	}

	private _etagRepository?: number;
	private _repositoryEventsDisposable: Disposable | undefined;
	private _repositoryLog?: GitLog;
	private _statusBarItem: StatusBarItem | undefined;
	private _theme: ColorTheme | undefined;

	private previewBanner?: boolean;

	constructor(container: Container) {
		super(
			container,
			'gitlens.graph',
			'graph.html',
			'images/gitlens-icon.png',
			'Commit Graph',
			'graphWebview',
			Commands.ShowGraphPage,
		);
		this.disposables.push(configuration.onDidChange(this.onConfigurationChanged, this), {
			dispose: () => {
				this._statusBarItem?.dispose();
				void this._repositoryEventsDisposable?.dispose();
			},
		});

		this.onConfigurationChanged();
	}

	override async show(column: ViewColumn = ViewColumn.Active, ...args: any[]): Promise<void> {
		if (!(await ensurePlusFeaturesEnabled())) return;

		if (this.container.git.repositoryCount > 1) {
			const [contexts] = parseCommandContext(Commands.ShowGraphPage, undefined, ...args);
			const context = Array.isArray(contexts) ? contexts[0] : contexts;

			if (context.type === 'scm' && context.scm.rootUri != null) {
				const repository = this.container.git.getRepository(context.scm.rootUri);
				if (repository != null) {
					this.repository = repository;
				}
			} else if (context.type === 'viewItem' && context.node instanceof RepositoryFolderNode) {
				this.repository = context.node.repo;
			}

			if (this.repository != null) {
				void this.refresh();
			}
		}

		return super.show(column, ...args);
	}

	protected override async includeBootstrap(): Promise<State> {
		return this.getState();
	}

	protected override onInitializing(): Disposable[] | undefined {
		this._theme = window.activeColorTheme;
		return [window.onDidChangeActiveColorTheme(this.onThemeChanged, this)];
	}

	protected override onMessageReceived(e: IpcMessage) {
		switch (e.method) {
			case DismissPreviewCommandType.method:
				onIpc(DismissPreviewCommandType, e, () => this.dismissPreview());
				break;
			case GetMoreCommitsCommandType.method:
				onIpc(GetMoreCommitsCommandType, e, params => this.onGetMoreCommits(params.limit));
				break;
			case UpdateColumnCommandType.method:
				onIpc(UpdateColumnCommandType, e, params => this.onColumnUpdated(params.name, params.config));
				break;
			case UpdateSelectedRepositoryCommandType.method:
				onIpc(UpdateSelectedRepositoryCommandType, e, params => this.onRepositorySelectionChanged(params.path));
				break;
			case UpdateSelectionCommandType.method:
				onIpc(UpdateSelectionCommandType, e, params => this.onSelectionChanged(params.selection));
				break;
		}
	}

	protected override onFocusChanged(focused: boolean): void {
		if (focused && this.selection != null) {
			void GitActions.Commit.showDetailsView(this.selection[0], { pin: true, preserveFocus: true });
		}
	}

	protected override onVisibilityChanged(visible: boolean): void {
		if (visible && this.repository != null && this.repository.etag !== this._etagRepository) {
			this._repositoryLog = undefined;
			void this.refresh();
		}
	}

	private onConfigurationChanged(e?: ConfigurationChangeEvent) {
		if (configuration.changed(e, 'graph.statusBar.enabled') || configuration.changed(e, 'plusFeatures.enabled')) {
			const enabled = configuration.get('graph.statusBar.enabled') && configuration.get('plusFeatures.enabled');
			if (enabled) {
				if (this._statusBarItem == null) {
					this._statusBarItem = window.createStatusBarItem(
						'gitlens.graph',
						StatusBarAlignment.Left,
						10000 - 3,
					);
					this._statusBarItem.name = 'GitLens Commit Graph';
					this._statusBarItem.command = Commands.ShowGraphPage;
					this._statusBarItem.text = '$(gitlens-graph)';
					this._statusBarItem.tooltip = new MarkdownString(
						'Visualize commits on the all-new Commit Graph ✨',
					);
					this._statusBarItem.accessibilityInformation = {
						label: `Show the GitLens Commit Graph`,
					};
				}
				this._statusBarItem.show();
			} else {
				this._statusBarItem?.dispose();
				this._statusBarItem = undefined;
			}
		}

		if (e != null && configuration.changed(e, 'graph')) {
			this.updateState();
		}
	}

	private onRepositoryChanged(e: RepositoryChangeEvent) {
		if (
			!e.changed(
				RepositoryChange.Config,
				RepositoryChange.Heads,
				RepositoryChange.Index,
				RepositoryChange.Remotes,
				RepositoryChange.RemoteProviders,
				RepositoryChange.Stash,
				RepositoryChange.Status,
				RepositoryChange.Tags,
				RepositoryChange.Unknown,
				RepositoryChangeComparisonMode.Any,
			)
		) {
			return;
		}

		this._repositoryLog = undefined;
		this.updateState();
	}

	private onThemeChanged(theme: ColorTheme) {
		if (this._theme != null) {
			if (
				(isDarkTheme(theme) && isDarkTheme(this._theme)) ||
				(isLightTheme(theme) && isLightTheme(this._theme))
			) {
				return;
			}
		}

		this._theme = theme;
		this.updateState();
	}

	private dismissPreview() {
		this.previewBanner = false;

		let banners = this.container.storage.getWorkspace('graph:banners:dismissed');
		banners = updateRecordValue(banners, 'preview', true);
		void this.container.storage.storeWorkspace('graph:banners:dismissed', banners);
	}

	private onColumnUpdated(name: string, config: GraphColumnConfig) {
		let columns = this.container.storage.getWorkspace('graph:columns');
		columns = updateRecordValue(columns, name, config);
		void this.container.storage.storeWorkspace('graph:columns', columns);

		void this.notifyDidChangeGraphConfiguration();
	}

	private async onGetMoreCommits(limit?: number) {
		if (this._repositoryLog?.more != null) {
			const { defaultItemLimit, pageItemLimit } = this.getConfig();
			const nextLog = await this._repositoryLog.more(limit ?? pageItemLimit ?? defaultItemLimit);
			if (nextLog != null) {
				this._repositoryLog = nextLog;
			}
		}
		void this.notifyDidChangeCommits();
	}

	private onRepositorySelectionChanged(path: string) {
		if (this.repository?.path !== path) {
			this.repository = this.container.git.getRepository(path);
		}
	}

	private async onSelectionChanged(selection: string[]) {
		const ref = selection[0];

		let commits: GitCommit[] | undefined;
		if (ref != null) {
			const commit = await this.repository?.getCommit(ref);
			if (commit != null) {
				commits = [commit];
			}
		}

		this._selection = commits;
		this._onDidChangeSelection.fire({ selection: commits ?? [] });

		if (commits == null) return;

		void GitActions.Commit.showDetailsView(commits[0], { pin: true, preserveFocus: true });
	}

	private _notifyDidChangeStateDebounced: Deferrable<() => void> | undefined = undefined;

	@debug()
	private updateState(immediate: boolean = false) {
		if (!this.isReady || !this.visible) return;

		if (immediate) {
			void this.notifyDidChangeState();
			return;
		}

		if (this._notifyDidChangeStateDebounced == null) {
			this._notifyDidChangeStateDebounced = debounce(this.notifyDidChangeState.bind(this), 500);
		}

		this._notifyDidChangeStateDebounced();
	}

	@debug()
	private async notifyDidChangeState() {
		if (!this.isReady || !this.visible) return false;

		return this.notify(DidChangeNotificationType, {
			state: await this.getState(),
		});
	}

	@debug()
	private async notifyDidChangeGraphConfiguration() {
		if (!this.isReady || !this.visible) return false;

		return this.notify(DidChangeGraphConfigurationNotificationType, {
			config: this.getConfig(),
		});
	}

	@debug()
	private async notifyDidChangeCommits() {
		if (!this.isReady || !this.visible) return false;

		const data = await this.getGraphData(true);
		return this.notify(DidChangeCommitsNotificationType, {
			rows: data.rows,
			log: formatLog(data.log),
			previousCursor: data.log?.previousCursor,
		});
	}

	private async getGraphData(paging: boolean = false): Promise<{ log: GitLog | undefined; rows: GraphRow[] }> {
		const supportsLogTips = (await this.repository?.supports(Features.LogBranchAndTagTips)) ?? false;

		const [logResult, stashResult, branchesResult, tagsResult, remotesResult] = await Promise.allSettled([
			this.getLog(),
			supportsLogTips ? undefined : this.getStash(),
			supportsLogTips ? undefined : this.getBranches(),
			supportsLogTips ? undefined : this.getTags(),
			this.getRemotes(),
		]);

		const log = getSettledValue(logResult);
		const commits = (paging ? log?.pagedCommits?.() : undefined) ?? log?.commits;

		const rows = await convertToRows(
			// combinedCommits,
			commits?.values(),
			getSettledValue(stashResult),
			getSettledValue(remotesResult),
			icon =>
				this._panel?.webview
					.asWebviewUri(
						Uri.joinPath(
							this.container.context.extensionUri,
							`images/${isLightTheme(window.activeColorTheme) ? 'light' : 'dark'}/icon-${icon}.svg`,
						),
					)
					.toString(),
			supportsLogTips,
			getSettledValue(branchesResult),
			getSettledValue(tagsResult),
		);

		return {
			log: log,
			rows: rows,
		};
	}

	private async getLog(): Promise<GitLog | undefined> {
		if (this.repository == null) return undefined;

		if (this._repositoryLog == null) {
			const { defaultItemLimit, pageItemLimit } = this.getConfig();
			const log = await this.container.git.getLog(this.repository.uri, {
				all: true,
				ordering: 'date',
				limit: defaultItemLimit ?? pageItemLimit,
			});
			if (log?.commits == null) return undefined;

			this._repositoryLog = log;
		}

		if (this._repositoryLog?.commits == null) return undefined;

		return this._repositoryLog;
	}

	private async getBranches(): Promise<GitBranch[] | undefined> {
		const branches = await this.repository?.getBranches();
		if (branches?.paging?.more) {
			debugger;
			// TODO@eamodio - implement paging
		}
		return branches?.values;
	}

	private async getTags(): Promise<GitTag[] | undefined> {
		const tags = await this.repository?.getTags();
		if (tags?.paging?.more) {
			debugger;
			// TODO@eamodio - implement paging
		}
		return tags?.values;
	}

	private async getRemotes(): Promise<GitRemote[] | undefined> {
		return this.repository?.getRemotes();
	}

	private async getStash(): Promise<GitStash | undefined> {
		// TODO@eamodio look into using `git log -g stash` to get stashes with the commits
		return this.repository?.getStash();
	}

	private getConfig(): GraphCompositeConfig {
		const settings = configuration.get('graph');
		const config: GraphCompositeConfig = {
			...settings,
			columns: this.container.storage.getWorkspace('graph:columns'),
		};
		return config;
	}

	private async getState(): Promise<State> {
		if (this.container.git.repositoryCount === 0) return { repositories: [] };

		if (this.previewBanner == null) {
			const banners = this.container.storage.getWorkspace('graph:banners:dismissed');
			this.previewBanner = !banners?.['preview'];
		}

		if (this.repository == null) {
			this.repository = this.container.git.getBestRepositoryOrFirst();
		}
		if (this.repository != null) {
			this.title = `${this.originalTitle}: ${this.repository.formattedName}`;
		}

		const data = await this.getGraphData(false);

		return {
			previewBanner: this.previewBanner,
			repositories: formatRepositories(this.container.git.openRepositories),
			selectedRepository: this.repository?.path,
			rows: data.rows,
			log: formatLog(data.log),
			config: this.getConfig(),
			nonce: this.cspNonce,
		};
	}
}

async function convertToRows(
	commits: Iterable<GitCommit> | undefined,
	stash: GitStash | undefined,
	remotes: GitRemote[] | undefined,
	getRemoteIconUrl: (icon?: string) => string | undefined,
	supportsLogTips: boolean,
	branches: GitBranch[] | undefined,
	tags: GitTag[] | undefined,
): Promise<GraphRow[]> {
	if (commits == null) return [];

	const rows: GraphRow[] = [];

	let current = false;
	let graphHeads: Head[];
	let graphTags: Tag[];
	let graphRemotes: Remote[];
	let parents: string[];
	let remoteName: string;
	let isStashCommit: boolean;

	const remoteMap = remotes != null ? new Map(remotes.map(r => [r.name, r])) : new Map();
	const skipStashParents = new Set();

	for (const commit of commits) {
		if (skipStashParents.has(commit.sha)) continue;

		if (supportsLogTips) {
			graphHeads = [];
			graphRemotes = [];
			graphTags = [];

			if (commit.tips != null) {
				for (let tip of commit.tips) {
					if (tip === 'refs/stash') continue;

					if (tip.startsWith('tag: ')) {
						graphTags.push({
							name: tip.substring(5),
							// Not currently used, so don't bother filling it out
							annotated: false,
						});

						continue;
					}

					current = tip.startsWith('HEAD -> ');
					if (current) {
						tip = tip.substring(8);
					}

					remoteName = getRemoteNameFromBranchName(tip);
					if (remoteName) {
						const remote = remoteMap.get(remoteName);
						if (remote != null) {
							graphRemotes.push({
								name: getBranchNameWithoutRemote(tip),
								owner: remote.name,
								url: remote.url,
								avatarUrl:
									remote.provider?.avatarUri?.toString(true) ??
									(remote?.provider?.icon != null
										? getRemoteIconUrl(remote.provider.icon)
										: undefined),
							});

							continue;
						}
					}

					graphHeads.push({
						name: tip,
						isCurrentHead: current,
					});
				}
			}
		} else {
			if (branches != null) {
				graphHeads = [
					...filterMap(branches, b => {
						if (b.sha !== commit.sha || b.remote) return undefined;

						return {
							name: b.name,
							isCurrentHead: b.current,
						};
					}),
				];

				graphRemotes = [
					...filterMap(branches, b => {
						if (b.sha !== commit.sha || !b.remote) return undefined;

						const remoteName = b.getRemoteName();
						const remote = remoteName != null ? remoteMap.get(remoteName) : undefined;

						return {
							name: b.getNameWithoutRemote(),
							url: remote?.url,
							avatarUrl:
								remote?.provider?.avatarUri?.toString(true) ??
								(remote?.provider?.icon != null ? getRemoteIconUrl(remote.provider.icon) : undefined),
							owner: remote?.name,
						};
					}),
				];
			} else {
				graphHeads = [];
				graphRemotes = [];
			}

			if (tags != null) {
				graphTags = [
					...filterMap(tags, t => {
						if (t.sha !== commit.sha) return undefined;

						return {
							name: t.name,
							annotated: Boolean(t.message),
						};
					}),
				];
			} else {
				graphTags = [];
			}
		}

		isStashCommit = isStash(commit) || (stash?.commits.has(commit.sha) ?? false);

		parents = commit.parents;
		// Remove the second & third parent, if exists, from each stash commit as it is a Git implementation for the index and untracked files
		if (isStashCommit && parents.length > 1) {
			// Copy the array to avoid mutating the original
			parents = [...parents];

			// Skip the "index commit" (e.g. contains staged files) of the stash
			skipStashParents.add(parents[1]);
			// Skip the "untracked commit" (e.g. contains untracked files) of the stash
			skipStashParents.add(parents[2]);
			parents.splice(1, 2);
		}

		rows.push({
			sha: commit.sha,
			parents: parents,
			author: commit.author.name,
			avatarUrl: !isStashCommit ? (await commit.getAvatarUri())?.toString(true) : undefined,
			email: commit.author.email ?? '',
			date: commit.committer.date.getTime(),
			message: emojify(commit.message && String(commit.message).length ? commit.message : commit.summary),
			// TODO: review logic for stash, wip, etc
			type: isStashCommit ? stashNodeType : commit.parents.length > 1 ? mergeNodeType : commitNodeType,
			heads: graphHeads,
			remotes: graphRemotes,
			tags: graphTags,
		});
	}

	return rows;
}

function formatLog(log: GitLog | undefined): GraphLog | undefined {
	if (log == null) return undefined;

	return {
		count: log.count,
		limit: log.limit,
		hasMore: log.hasMore,
		cursor: log.cursor,
	};
}

function formatRepositories(repositories: Repository[]): GraphRepository[] {
	if (repositories.length === 0) return repositories;

	return repositories.map(r => ({
		formattedName: r.formattedName,
		id: r.id,
		name: r.name,
		path: r.path,
	}));
}

function isDarkTheme(theme: ColorTheme): boolean {
	return theme.kind === ColorThemeKind.Dark || theme.kind === ColorThemeKind.HighContrast;
}

function isLightTheme(theme: ColorTheme): boolean {
	return theme.kind === ColorThemeKind.Light || theme.kind === ColorThemeKind.HighContrastLight;
}
