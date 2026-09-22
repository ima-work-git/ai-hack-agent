import { describe, expect, it } from 'vitest';
import { extractExplicitXHandles } from '../src/shared/x-account.ts';

describe('explicit X account identifiers', () => {
  it('accepts direct mentions in Japanese text and preserves first-appearance order', () => {
    expect(extractExplicitXHandles('こちらは@Fixture_Oneさん、続いて（@Fixture_Two）です。')).toEqual(['fixture_one', 'fixture_two']);
  });
  it('accepts only exact HTTPS profile URLs and ignores language queries', () => {
    expect(extractExplicitXHandles('https://x.com/Fixture_User?lang=ja https://twitter.com/Fixture_Two/')).toEqual(['fixture_user', 'fixture_two']);
    expect(extractExplicitXHandles('紹介：https://X.COM/Fixture_User。')).toEqual(['fixture_user']);
  });
  it('deduplicates URLs and mentions case-insensitively in input order', () => {
    expect(extractExplicitXHandles('@Fixture_Two https://x.com/FIXTURE_USER?lang=ja @fixture_user https://twitter.com/fixture_two')).toEqual(['fixture_two', 'fixture_user']);
  });
  it('does not extract @text from URL credentials, paths, query strings or fragments', () => {
    expect(extractExplicitXHandles('https://fixture@x.com/one https://evil.invalid/@bad https://x.com/home?q=@bad#@bad2')).toEqual([]);
    expect(extractExplicitXHandles('https://x.com/Fixture_User?next=@other#@third @fixture_four')).toEqual(['fixture_user', 'fixture_four']);
    expect(extractExplicitXHandles('http://x.com/fixture_user?q=@other ftp://evil.invalid/@bad')).toEqual([]);
    expect(extractExplicitXHandles('//x.com/@bad //evil.invalid/route?q=@bad')).toEqual([]);
  });
  it.each([
    'http://x.com/fixture_user', 'https://www.x.com/fixture_user',
    'https://x.com.evil.invalid/fixture_user', 'https://notx.com/fixture_user',
    'https://twitter.com.evil.invalid/fixture_user', 'https://x.com./fixture_user',
    'https://x.com:443/fixture_user', 'https://x.com:8443/fixture_user',
    'https://user:password@x.com/fixture_user', 'https://x.com@evil.invalid/fixture_user',
    'https://x.com/fixture_user/status/123', 'https://twitter.com/fixture_user/following',
    'https://x.com//fixture_user', 'https://x.com/%66ixture_user',
    'https://x.com/other/../fixture_user', 'https://x.com/%2e/fixture_user',
    'https://x.com/fixture_user%2fstatus', 'https://x.com/fixture-user',
    'https://x.com/abcdefghijklmnop', 'https://x.com', 'https://x.com/',
    'https://x.com\\fixture_user',
  ])('rejects non-profile or unsafe URL %s', url => {
    expect(extractExplicitXHandles(url)).toEqual([]);
  });
  it.each(['home', 'explore', 'search', 'i', 'intent', 'settings', 'login', 'logout', 'signup', 'messages', 'notifications', 'compose', 'share', 'hashtag', 'status'])('ignores reserved profile path %s', path => {
    expect(extractExplicitXHandles(`https://x.com/${path}?lang=ja https://twitter.com/${path.toUpperCase()}/`)).toEqual([]);
  });
  it('does not read email local parts or embedded and oversized mentions', () => {
    expect(extractExplicitXHandles('fixture@example.com team+@example.com team.@example.com A@fixture_user _@fixture_user @@fixture_user @abcdefghijklmnop')).toEqual([]);
    expect(extractExplicitXHandles('メールはfixture@example.com、Xは@Fixture_Userです。')).toEqual(['fixture_user']);
  });
  it('accepts boundary lengths without inferring bare usernames or fullwidth mentions', () => {
    expect(extractExplicitXHandles('@a @abcdefghijklmno fixture_user ＠fixture_user')).toEqual(['a', 'abcdefghijklmno']);
  });
});
