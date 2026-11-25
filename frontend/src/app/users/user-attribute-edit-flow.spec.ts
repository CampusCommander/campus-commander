import { describe, expect, it } from 'vitest';
import { attributeAnswerMessage } from './user-attribute-edit-flow';

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
