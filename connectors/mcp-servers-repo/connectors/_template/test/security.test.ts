import { describe, it, expect } from 'vitest';
import { validateHostname } from '../src/utils.js';

describe('validateHostname — bypass regression tests', () => {
  describe('localhost with port (no scheme)', () => {
    it('rejects localhost:3000', () => {
      expect(() => validateHostname('localhost:3000')).toThrow('localhost is not allowed');
    });

    it('rejects localhost:8080', () => {
      expect(() => validateHostname('localhost:8080')).toThrow('localhost is not allowed');
    });
  });

  describe('private IPs with port (no scheme)', () => {
    it('rejects 127.0.0.1:8080', () => {
      expect(() => validateHostname('127.0.0.1:8080')).toThrow('Private IP address');
    });

    it('rejects 10.0.0.1:443', () => {
      expect(() => validateHostname('10.0.0.1:443')).toThrow('Private IP address');
    });
  });

  describe('userinfo-style URLs', () => {
    it('rejects https://user@localhost/', () => {
      expect(() => validateHostname('https://user@localhost/')).toThrow('localhost is not allowed');
    });

    it('rejects https://attacker@10.0.0.1/', () => {
      expect(() => validateHostname('https://attacker@10.0.0.1/')).toThrow('Private IP address');
    });
  });

  describe('IPv6 loopback with port', () => {
    it('rejects [::1]:8080', () => {
      expect(() => validateHostname('[::1]:8080')).toThrow('IPv6 loopback');
    });
  });

  describe('existing validations still work', () => {
    it('rejects bare localhost', () => {
      expect(() => validateHostname('localhost')).toThrow('localhost is not allowed');
    });

    it('rejects bare 127.0.0.1', () => {
      expect(() => validateHostname('127.0.0.1')).toThrow('Private IP address');
    });

    it('rejects bare [::1]', () => {
      expect(() => validateHostname('[::1]')).toThrow('IPv6 loopback');
    });

    it('rejects bare ::1', () => {
      expect(() => validateHostname('::1')).toThrow('IPv6 loopback');
    });

    it('rejects http:// scheme', () => {
      expect(() => validateHostname('http://example.com')).toThrow('not allowed');
    });

    it('rejects empty string', () => {
      expect(() => validateHostname('')).toThrow('must not be empty');
    });

    it('accepts valid public hostname', () => {
      expect(validateHostname('api.example.com')).toBe('api.example.com');
    });

    it('accepts valid HTTPS URL', () => {
      expect(validateHostname('https://api.example.com/path')).toBe('api.example.com');
    });
  });
});
