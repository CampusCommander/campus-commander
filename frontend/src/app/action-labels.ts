import { type Action } from '@campus/application-contracts';

export const actionLabels: Record<Action, string> = {
  'customer:read': 'Read customer settings',
  'customer:write': 'Change customer settings',
  'connection:read': 'Read Google connection status',
  'connection:diagnose': 'Check Google connection',
  'connection:manage': 'Manage Google credentials',
  'platform-users:read': 'Read platform access',
  'platform-users:invite': 'Invite platform users',
  'platform-users:manage': 'Manage platform access',
  'schools:read': 'Read school scopes',
  'schools:manage': 'Manage school scopes',
  'security-events:read': 'Read security events',
};
