import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import type { JobDetail } from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import {
  UserAttributeEditFlow,
  attributeAnswerMessage,
} from './user-attribute-edit-flow';

describe('the card form refusals', () => {
  it('names the size limit with the exact words of the card', () => {
    expect(attributeAnswerMessage(413, { code: 'payload-too-large' })).toBe(
      'The request exceeds the size limit.',
    );
  });

  it('names the category and preview conflicts', () => {
    expect(attributeAnswerMessage(409, { reason: 'category-changed' })).toBe(
      'Another change reached this category. Review the values and save again.',
    );
    expect(attributeAnswerMessage(409, { reason: 'preview-conflict' })).toBe(
      'A value changed in Google after you opened the form. Review the values and save again.',
    );
    expect(attributeAnswerMessage(409, { reason: 'preview-changed' })).toBe(
      'The preview changed. Save the changes again.',
    );
  });

  it('names an expired preview with 410 Gone', () => {
    expect(attributeAnswerMessage(410, { reason: 'preview-expired' })).toBe(
      'The preview expired. Save the changes again.',
    );
  });

  it('keeps the API message of a refused value', () => {
    expect(
      attributeAnswerMessage(422, {
        message: 'Grade level holds a value from 0 to 12.',
      }),
    ).toBe('Grade level holds a value from 0 to 12.');
  });

  it('reads the Google failure of a user read', () => {
    expect(
      attributeAnswerMessage(503, {
        reason: 'user-read-failed',
        failure: 'credential-rejected',
      }),
    ).toContain('Credential rejected');
  });

  it('names a forbidden save and a missing preview', () => {
    expect(attributeAnswerMessage(403, {})).toBe(
      'You do not have permission to set user attribute values.',
    );
    expect(attributeAnswerMessage(404, {})).toBe(
      'Campus Commander could not read the preview. Retry the save.',
    );
  });
});

/** One read of a value job. Only the status matters to the poller. */
function jobAnswer(status: string): { ok: true; value: JobDetail } {
  return {
    ok: true,
    value: { displayId: 'UAT-015', status } as unknown as JobDetail,
  };
}

function flowService(): UserAttributeEditFlow {
  TestBed.configureTestingModule({
    providers: [{ provide: AuthStore, useValue: { request: vi.fn() } }],
  });
  return TestBed.inject(UserAttributeEditFlow);
}

describe('the value job observation', () => {
  it('keeps reading after a transient failure (R1-E)', async () => {
    const flow = flowService();
    const read = vi
      .spyOn(flow, 'readJob')
      .mockResolvedValueOnce({
        ok: false,
        message: 'Cannot reach Campus Commander. Your changes are still here.',
      })
      .mockResolvedValueOnce(jobAnswer('running'))
      .mockResolvedValueOnce(jobAnswer('completed'));
    const answer = await flow.waitForJob('UAT-015', 5, 0);
    expect(answer).toEqual(jobAnswer('completed'));
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('settles on a terminal answer at the final allowed read (R1-E)', async () => {
    const flow = flowService();
    const read = vi
      .spyOn(flow, 'readJob')
      .mockResolvedValueOnce(jobAnswer('running'))
      .mockResolvedValueOnce(jobAnswer('completed'));
    const answer = await flow.waitForJob('UAT-015', 2, 0);
    expect(answer).toEqual(jobAnswer('completed'));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('keeps the receipt when the final read fails', async () => {
    const flow = flowService();
    vi.spyOn(flow, 'readJob')
      .mockResolvedValueOnce(jobAnswer('running'))
      .mockResolvedValueOnce({
        ok: false,
        message: 'Cannot reach Campus Commander. Your changes are still here.',
      });
    const answer = await flow.waitForJob('UAT-015', 2, 0);
    expect(answer.ok).toBe(false);
  });

  it('stops polling when its card ended', async () => {
    const flow = flowService();
    const read = vi
      .spyOn(flow, 'readJob')
      .mockResolvedValue(jobAnswer('running'));
    let reads = 0;
    const answer = await flow.waitForJob('UAT-015', 10, 0, () => {
      reads++;
      return reads > 1;
    });
    expect(answer.ok).toBe(false);
    expect(read.mock.calls.length).toBeLessThan(10);
  });
});
