import { GithubAuthProvider } from './auth/GithubAuthProvider.js';
import { GithubActionsClient } from './github/GithubActionsClient.js';
import { GithubEnvironmentsClient } from './github/GithubEnvironmentsClient.js';
import { GithubOrgsClient } from './github/GithubOrgsClient.js';
import { GithubSearchClient } from './github/GithubSearchClient.js';
import { WorkspaceConfigManager } from './config/WorkspaceConfigManager.js';
import { TerraformFileCache } from './cache/TerraformFileCache.js';

export interface ExtensionServices {
  auth: GithubAuthProvider;
  actionsClient: GithubActionsClient;
  envsClient: GithubEnvironmentsClient;
  orgsClient: GithubOrgsClient;
  searchClient: GithubSearchClient;
  configManager: WorkspaceConfigManager;
  tfCache: TerraformFileCache;
}
