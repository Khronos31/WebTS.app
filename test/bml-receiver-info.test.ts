import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getZipcode, normalizeZipcode, setZipcode } from '../src/epg-ui/bml-receiver-info';

describe('郵便番号の正規化', () => {
  it('7桁の数字はそのまま', () => {
    expect(normalizeZipcode('1500001')).toBe('1500001');
  });

  it('ハイフン・空白・〒を落とす', () => {
    expect(normalizeZipcode('150-0001')).toBe('1500001');
    expect(normalizeZipcode(' 〒150 0001 ')).toBe('1500001');
    expect(normalizeZipcode('150ー0001')).toBe('1500001');
    expect(normalizeZipcode('150－0001')).toBe('1500001');
  });

  it('全角数字を半角にする', () => {
    expect(normalizeZipcode('１５０－０００１')).toBe('1500001');
  });

  it('桁が合わなければ null（補わない・切らない）', () => {
    expect(normalizeZipcode('150001')).toBeNull();
    expect(normalizeZipcode('15000011')).toBeNull();
    expect(normalizeZipcode('')).toBeNull();
  });

  it('数字以外が混ざれば null', () => {
    expect(normalizeZipcode('150-000a')).toBeNull();
  });
});

describe('郵便番号の読み書き (getZipcode / setZipcode)', () => {
  const store = new Map<string, string>();
  const mockLocalStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, val: string) => {
      store.set(key, val);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    get length() {
      return store.size;
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
  };

  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', mockLocalStorage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('未設定時は null を返す', () => {
    expect(getZipcode()).toBeNull();
  });

  it('正しい郵便番号を設定・取得できる', () => {
    expect(setZipcode('100-0001')).toBe(true);
    expect(getZipcode()).toBe('1000001');
  });

  it('空文字または null で削除できる', () => {
    setZipcode('1000001');
    expect(getZipcode()).toBe('1000001');
    expect(setZipcode(null)).toBe(true);
    expect(getZipcode()).toBeNull();

    setZipcode('1000001');
    expect(setZipcode('')).toBe(true);
    expect(getZipcode()).toBeNull();
  });

  it('不正な形式のときは設定されず false を返す', () => {
    expect(setZipcode('invalid')).toBe(false);
    expect(getZipcode()).toBeNull();
    expect(setZipcode('12345')).toBe(false);
  });
});
