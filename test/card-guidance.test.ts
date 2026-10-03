import { describe, expect, it } from 'vitest';
import { isCardMissing } from '../src/epg-ui/q3u4-module';

describe('カードが無いときの案内', () => {
  it('カードが無い・抜かれたときだけ案内を出す', () => {
    expect(isCardMissing('card-connect-no-card')).toBe(true);
    expect(isCardMissing('card-transmit-no-card')).toBe(true);
    expect(isCardMissing('card-connect-removed')).toBe(true);
    expect(isCardMissing('card-transmit-removed')).toBe(true);
  });

  it('ほかのカードの理由や、開けなかった理由には出さない', () => {
    expect(isCardMissing('card-connect-timeout')).toBe(false);
    expect(isCardMissing('card-init')).toBe(false);
    expect(isCardMissing('none')).toBe(false);
    expect(isCardMissing('webusb-descriptor')).toBe(false);
  });
});
