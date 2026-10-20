import type { DeviceType, UaInfo } from '../types.js';

interface Rule {
  family: string;
  pattern: RegExp;
  deviceType: DeviceType;
  isBot?: boolean;
  isGoogleProxy?: boolean;
  isAppleMail?: boolean;
}

// Order matters: more specific patterns first.
const RULES: Rule[] = [
  { family: 'GoogleImageProxy', pattern: /GoogleImageProxy/i, deviceType: 'proxy', isGoogleProxy: true },
  // Bots / scanners / link-and-image scanners (doc 02 §5 R6).
  { family: 'curl', pattern: /\bcurl\//i, deviceType: 'bot', isBot: true },
  { family: 'wget', pattern: /\bWget\//i, deviceType: 'bot', isBot: true },
  { family: 'python-requests', pattern: /python-requests/i, deviceType: 'bot', isBot: true },
  { family: 'Go-http-client', pattern: /Go-http-client/i, deviceType: 'bot', isBot: true },
  { family: 'HeadlessChrome', pattern: /HeadlessChrome/i, deviceType: 'bot', isBot: true },
  { family: 'Slackbot', pattern: /Slackbot/i, deviceType: 'bot', isBot: true },
  { family: 'Proofpoint', pattern: /Proofpoint/i, deviceType: 'bot', isBot: true },
  { family: 'Mimecast', pattern: /Mimecast/i, deviceType: 'bot', isBot: true },
  { family: 'Barracuda', pattern: /Barracuda/i, deviceType: 'bot', isBot: true },
  { family: 'bot', pattern: /\b(bot|crawler|spider|preview)\b/i, deviceType: 'bot', isBot: true },
  // Mail clients.
  { family: 'AppleMail', pattern: /\b(iPhone|iPad|iPod).*Mail\b|Mail\/[\d.]+ CFNetwork|Macintosh.*Mail\/\d/i, deviceType: 'desktop', isAppleMail: true },
  {
    family: 'AppleMail',
    pattern: /CFNetwork\/.*Darwin/i,
    deviceType: 'desktop',
    isAppleMail: true,
  },
  { family: 'Outlook', pattern: /Microsoft Outlook|MSOffice|Outlook-(iOS|Android)/i, deviceType: 'desktop' },
  { family: 'Thunderbird', pattern: /Thunderbird\//i, deviceType: 'desktop' },
  { family: 'YahooMail', pattern: /YahooMobileMail|Yahoo.*Mail/i, deviceType: 'mobile' },
  // Browsers - device type derived from OS tokens below; family here.
  { family: 'Edge', pattern: /Edg(?:e|A|iOS)?\//i, deviceType: 'desktop' },
  { family: 'Chrome', pattern: /Chrome\//i, deviceType: 'desktop' },
  { family: 'Firefox', pattern: /Firefox\//i, deviceType: 'desktop' },
  { family: 'Safari', pattern: /Safari\//i, deviceType: 'desktop' },
];

function detectOs(ua: string): string | null {
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macOS';
  if (/Android/i.test(ua)) return 'Android';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Linux/i.test(ua)) return 'Linux';
  return null;
}

function detectDeviceTypeFromOs(ua: string, fallback: DeviceType): DeviceType {
  if (/iPad|Tablet/i.test(ua)) return 'tablet';
  if (/iPhone|Android.*Mobile|Mobile.*Android/i.test(ua)) return 'mobile';
  if (/Android/i.test(ua)) return 'tablet';
  return fallback;
}

export function parseUserAgent(ua: string | null): UaInfo {
  if (ua === null || ua.trim() === '') {
    // A pixel fetch with no UA at all is treated as a scanner signature.
    return {
      family: null,
      deviceType: 'unknown',
      os: null,
      isGoogleProxy: false,
      isBot: true,
      isAppleMail: false,
    };
  }

  for (const rule of RULES) {
    if (rule.pattern.test(ua)) {
      const isBrowserFamily = ['Edge', 'Chrome', 'Firefox', 'Safari'].includes(rule.family);
      const deviceType =
        rule.deviceType === 'bot' || rule.deviceType === 'proxy'
          ? rule.deviceType
          : isBrowserFamily
            ? detectDeviceTypeFromOs(ua, rule.deviceType)
            : rule.deviceType;
      return {
        family: rule.family,
        deviceType,
        os: detectOs(ua),
        isGoogleProxy: rule.isGoogleProxy ?? false,
        isBot: rule.isBot ?? false,
        isAppleMail: rule.isAppleMail ?? false,
      };
    }
  }

  return {
    family: null,
    deviceType: 'unknown',
    os: detectOs(ua),
    isGoogleProxy: false,
    isBot: false,
    isAppleMail: false,
  };
}
