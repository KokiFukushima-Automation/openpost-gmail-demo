import { describe, expect, it } from 'vitest';
import { parseUserAgent } from '../../src/core/ua.js';

interface Fixture {
  ua: string | null;
  family: string | null;
  deviceType: string;
  isGoogleProxy: boolean;
  isBot: boolean;
  isAppleMail: boolean;
}

const FIXTURES: Fixture[] = [
  {
    ua: 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)',
    family: 'GoogleImageProxy',
    deviceType: 'proxy',
    isGoogleProxy: true,
    isBot: false,
    isAppleMail: false,
  },
  {
    ua: 'curl/8.5.0',
    family: 'curl',
    deviceType: 'bot',
    isGoogleProxy: false,
    isBot: true,
    isAppleMail: false,
  },
  {
    ua: 'Wget/1.21.3 (linux-gnu)',
    family: 'wget',
    deviceType: 'bot',
    isGoogleProxy: false,
    isBot: true,
    isAppleMail: false,
  },
  {
    ua: 'python-requests/2.32.0',
    family: 'python-requests',
    deviceType: 'bot',
    isGoogleProxy: false,
    isBot: true,
    isAppleMail: false,
  },
  {
    ua: 'Go-http-client/1.1',
    family: 'Go-http-client',
    deviceType: 'bot',
    isGoogleProxy: false,
    isBot: true,
    isAppleMail: false,
  },
  {
    ua: 'Mozilla/5.0 HeadlessChrome/120.0.0.0 Safari/537.36',
    family: 'HeadlessChrome',
    deviceType: 'bot',
    isGoogleProxy: false,
    isBot: true,
    isAppleMail: false,
  },
  {
    ua: 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    family: 'Slackbot',
    deviceType: 'bot',
    isGoogleProxy: false,
    isBot: true,
    isAppleMail: false,
  },
  {
    ua: 'Mozilla/5.0 (compatible; Proofpoint URL Rewrite Service)',
    family: 'Proofpoint',
    deviceType: 'bot',
    isGoogleProxy: false,
    isBot: true,
    isAppleMail: false,
  },
  {
    ua: 'Mozilla/5.0 (compatible; Mimecast Scanner)',
    family: 'Mimecast',
    deviceType: 'bot',
    isGoogleProxy: false,
    isBot: true,
    isAppleMail: false,
  },
  {
    ua: 'Barracuda Sentinel/1.0',
    family: 'Barracuda',
    deviceType: 'bot',
    isGoogleProxy: false,
    isBot: true,
    isAppleMail: false,
  },
  {
    ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    family: 'bot',
    deviceType: 'bot',
    isGoogleProxy: false,
    isBot: true,
    isAppleMail: false,
  },
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Mail/16.0 CFNetwork/1408.0.4 Darwin/22.5.0',
    family: 'AppleMail',
    deviceType: 'desktop',
    isGoogleProxy: false,
    isBot: false,
    isAppleMail: true,
  },
  {
    ua: 'Microsoft Outlook 16.0',
    family: 'Outlook',
    deviceType: 'desktop',
    isGoogleProxy: false,
    isBot: false,
    isAppleMail: false,
  },
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Trident/7.0; rv:11.0) like Gecko MSOffice 16',
    family: 'Outlook',
    deviceType: 'desktop',
    isGoogleProxy: false,
    isBot: false,
    isAppleMail: false,
  },
  {
    ua: 'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Thunderbird/120.0',
    family: 'Thunderbird',
    deviceType: 'desktop',
    isGoogleProxy: false,
    isBot: false,
    isAppleMail: false,
  },
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    family: 'Chrome',
    deviceType: 'desktop',
    isGoogleProxy: false,
    isBot: false,
    isAppleMail: false,
  },
  {
    ua: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    family: 'Chrome',
    deviceType: 'mobile',
    isGoogleProxy: false,
    isBot: false,
    isAppleMail: false,
  },
  {
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    family: 'Safari',
    deviceType: 'mobile',
    isGoogleProxy: false,
    isBot: false,
    isAppleMail: false,
  },
  {
    ua: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    family: 'Safari',
    deviceType: 'tablet',
    isGoogleProxy: false,
    isBot: false,
    isAppleMail: false,
  },
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
    family: 'Edge',
    deviceType: 'desktop',
    isGoogleProxy: false,
    isBot: false,
    isAppleMail: false,
  },
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; rv:120.0) Gecko/20100101 Firefox/120.0',
    family: 'Firefox',
    deviceType: 'desktop',
    isGoogleProxy: false,
    isBot: false,
    isAppleMail: false,
  },
  {
    ua: null,
    family: null,
    deviceType: 'unknown',
    isGoogleProxy: false,
    isBot: true,
    isAppleMail: false,
  },
  {
    ua: 'SomeTotallyUnknownClient/1.0',
    family: null,
    deviceType: 'unknown',
    isGoogleProxy: false,
    isBot: false,
    isAppleMail: false,
  },
];

describe('ua', () => {
  it('29. parses a fixture table of real-world UA strings', () => {
    for (const fixture of FIXTURES) {
      const info = parseUserAgent(fixture.ua);
      expect(info.family, `family for ${String(fixture.ua)}`).toBe(fixture.family);
      expect(info.deviceType, `deviceType for ${String(fixture.ua)}`).toBe(fixture.deviceType);
      expect(info.isGoogleProxy, `isGoogleProxy for ${String(fixture.ua)}`).toBe(fixture.isGoogleProxy);
      expect(info.isBot, `isBot for ${String(fixture.ua)}`).toBe(fixture.isBot);
      expect(info.isAppleMail, `isAppleMail for ${String(fixture.ua)}`).toBe(fixture.isAppleMail);
    }
  });
});
