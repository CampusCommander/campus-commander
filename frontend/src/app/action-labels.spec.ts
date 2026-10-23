import { describe, expect, it } from 'vitest';
import { actionSchema } from '@campus/application-contracts';
import { actionLabels } from './action-labels';

describe('action labels', () => {
  it('labels every declared action', () => {
    for (const action of actionSchema.options)
      expect(actionLabels[action], `${action} has a label`).toBeTruthy();
  });

  it('names the wipe and deprovision actions', () => {
    expect(actionLabels['devices:wipe']).toBe('Wipe and Powerwash devices');
    expect(actionLabels['devices:deprovision']).toBe('Device Deprovision');
  });
});
