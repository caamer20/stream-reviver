import assert from "node:assert/strict";
import test from "node:test";
import { browserOriginPattern, hasOtherEnabledOriginSharingPermission } from "../../src/shared/origin-permissions";

test("Firefox permissions omit ports while Chrome retains non-default ports", () => {
  assert.equal(browserOriginPattern("http://localhost:8080", "firefox"), "http://localhost/*");
  assert.equal(browserOriginPattern("http://localhost:8080", "chrome"), "http://localhost:8080/*");
  assert.equal(browserOriginPattern("https://example.com:443", "firefox"), "https://example.com/*");
  assert.equal(browserOriginPattern("https://example.com:443", "chrome"), "https://example.com/*");
  assert.equal(browserOriginPattern("http://[::1]:8080", "firefox"), "http://[::1]/*");
  assert.equal(browserOriginPattern("http://[::1]:8080", "chrome"), "http://[::1]:8080/*");
});
test("origin patterns reject unsupported origins and preserve file behavior", () => {
  for (const browser of ["firefox", "chrome"] as const) {
    assert.equal(browserOriginPattern("file://", browser), "file:///*");
    for (const origin of ["not a URL", "about:blank", "javascript:alert(1)", "ftp://example.com"]) {
      assert.equal(browserOriginPattern(origin, browser), null);
    }
  }
});
test("disabling a Firefox port retains permission needed by an enabled sibling", () => {
  const sites = { "https://example.com:8080": { enabled: false }, "https://example.com:9090": { enabled: true } };
  assert.equal(hasOtherEnabledOriginSharingPermission(sites, "https://example.com:8080", "firefox"), true);
  assert.equal(hasOtherEnabledOriginSharingPermission(sites, "https://example.com:8080", "chrome"), false);
});
test("disabled siblings, other schemes and other hosts cannot retain a grant", () => {
  const sites = {
    "https://example.com:8080": { enabled: true },
    "https://example.com:9090": { enabled: false },
    "https://example.com:7070": {},
    "http://example.com:9090": { enabled: true },
    "https://other.example:9090": { enabled: true }
  };
  assert.equal(hasOtherEnabledOriginSharingPermission(sites, "https://example.com:8080", "firefox"), false);
  assert.equal(hasOtherEnabledOriginSharingPermission(sites, "invalid", "firefox"), false);
});
