import { type Action } from '@campus/application-contracts';

export const actionLabels: Record<Action, string> = {
  'customer:read': 'View customer settings',
  'customer:write': 'Change customer settings',
  'connection:read': 'View Google connection status',
  'connection:diagnose': 'Check Google connection',
  'connection:manage': 'Manage Google credentials',
  'platform-users:read': 'View platform access',
  'platform-users:invite': 'Invite platform users',
  'platform-users:manage': 'Manage platform access',
  'schools:read': 'View schools',
  'schools:manage': 'Manage schools',
  'security-events:read': 'View security events',
};
