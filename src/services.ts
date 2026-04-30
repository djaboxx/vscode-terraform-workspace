import { GithubAuthProvider } from './auth/GithubAuthProvider.js';
import { GithubActionsClient } from './github/GithubActionsClient.js';
import { GithubEnvironmentsClient } from './github/GithubEnvironmentsClient.js';
import { GithubOrgsClient } from './github/GithubOrgsClient.js';
import { GithubSearchClient } from './github/GithubSearchClient.js';
import { GithubModuleClient } from './github/GithubModuleClient.js';
import { WorkspaceConfigManager } from './config/WorkspaceConfigManager.js';
import { TerraformFileCache } from './cache/TerraformFileCache.js';
import { LocalActionsScaffolder } from './workflows/LocalActionsScaffolder.js';
import { ActionlintRunner } from './workflows/ActionlintRunner.js';
import { DriftDetector } from './workflows/DriftDetector.js';
import { Telemetry } from './services/Telemetry.js';

export interface ExtensionServices {
  auth: GithubAuthProvider;
  actionsClient: GithubActionsClient;
  envsClient: GithubEnvironmentsClient;
  orgsClient: GithubOrgsClient;
  searchClient: GithubSearchClient;
  moduleClient: GithubModuleClient;
  configManager: WorkspaceConfigManager;
  tfCache: TerraformFileCache;
  actionsScaffolder: LocalActionsScaffolder;
  /** Optional — set after construction to avoid circular deps. */
  actionlint?: ActionlintRunner;
  /** Optional — set after construction to avoid circular deps. */
  drift?: DriftDetector;
  /** Optional — set after construction to avoid circular deps. */
  telemetry?: Telemetry;
}
