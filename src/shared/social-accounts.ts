import type { Target } from './contracts.ts';
import { normalizeIdentity } from './identity-aliases.ts';

export type SocialPlatform = 'instagram' | 'facebook';
export interface VerifiedSocialAccount {
  readonly platform: SocialPlatform;
  readonly handle: string;
  readonly profileUrl: string;
  readonly identitySourceUrl: string;
}
export interface VerifiedSocialIdentity {
  readonly id: string;
  readonly canonicalName: string;
  readonly personNames: readonly string[];
  readonly companyNames: readonly string[];
  readonly accounts: readonly VerifiedSocialAccount[];
}

/** Public links checked on 2026-09-22. These select an account to fetch, not
 * proof that a speaker is that person or that a returned post is theirs. */
export const VERIFIED_SOCIAL_IDENTITIES: readonly VerifiedSocialIdentity[] = [
  {
    id: 'madoka-chiyoda', canonicalName: '千代田まどか',
    personNames: ['千代田まどか', 'ちよだまどか', 'ちょまど', 'Chomado', 'Madoka Chiyoda', '@chomado'],
    companyNames: ['Microsoft', 'マイクロソフト', '日本マイクロソフト'],
    accounts: [
      { platform: 'instagram', handle: 'chomado', profileUrl: 'https://www.instagram.com/chomado', identitySourceUrl: 'https://linktr.ee/chomado' },
      { platform: 'facebook', handle: 'chomado', profileUrl: 'https://www.facebook.com/chomado', identitySourceUrl: 'https://linktr.ee/chomado' },
    ],
  },
  {
    id: 'taishi-yamasaki', canonicalName: '山崎大志',
    personNames: ['山崎大志', 'やまさきたいし', 'Taishi', 'たいし', 'Taishi Yamasaki', 'taishiyade', '@taishiyade'],
    companyNames: ['AlphaByte', 'AlphaByte株式会社', '株式会社AlphaByte', 'アルファバイト'],
    accounts: [
      { platform: 'instagram', handle: 'taishi_jade', profileUrl: 'https://www.instagram.com/taishi_jade', identitySourceUrl: 'https://taishiyade.com/' },
      { platform: 'facebook', handle: 'taishi.yamasaki.98', profileUrl: 'https://www.facebook.com/taishi.yamasaki.98/', identitySourceUrl: 'https://taishiyade.com/' },
    ],
  },
];

/** No company clue is required, but an explicit conflicting clue fails closed. */
export function verifiedSocialIdentityForTarget(target: Target): VerifiedSocialIdentity | undefined {
  const name = normalizeIdentity(target.personName).replace(/(?:さん|氏|様)$/, '');
  const company = normalizeIdentity(target.companyName);
  const matches = VERIFIED_SOCIAL_IDENTITIES.filter(identity =>
    identity.personNames.some(alias => normalizeIdentity(alias) === name) &&
    (!company || identity.companyNames.some(alias => normalizeIdentity(alias) === company)));
  return matches.length === 1 ? matches[0] : undefined;
}
