import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanPageUrl,
  isLiveHost,
  isPanelPath,
  isUntrackedPath,
  validMeasurementId,
} from "../src/lib/analytics-rules.ts";

test("analytics: only the live address counts", () => {
  assert.equal(isLiveHost("grainbazar.com"), true);
  assert.equal(isLiveHost("www.grainbazar.com"), true);
  assert.equal(isLiveHost("localhost"), false);
  assert.equal(isLiveHost("127.0.0.1"), false);
  assert.equal(isLiveHost("shamibusinessventures.vercel.app"), false);
  assert.equal(isLiveHost("grainbazar.com.example.com"), false);
});

test("analytics: every staff panel is left out, however the address is typed", () => {
  for (const path of [
    "/admin",
    "/admin/",
    "/admin/login",
    "/admin/orders/GB-ORD-1",
    "/vendor/dashboard",
    "/vendor/register",
    "/partner",
    "/partner/attendance",
    "/staff",
    "/staff/device",
    "/ADMIN/Login",
  ]) {
    assert.equal(isPanelPath(path), true, path);
    assert.equal(isUntrackedPath(path), true, path);
  }
});

test("analytics: a customer's private pages are left out but don't mark the device as staff", () => {
  for (const path of ["/account", "/account/orders/GB-ORD-1", "/reset-password"]) {
    assert.equal(isUntrackedPath(path), true, path);
    assert.equal(isPanelPath(path), false, path);
  }
});

test("analytics: shop pages are counted, including ones that only start like a panel", () => {
  for (const path of [
    "/",
    "/shop",
    "/product/P001",
    "/categories/rice",
    "/cart",
    "/checkout",
    "/login",
    "/register",
    "/contact",
    "/about",
    "/wishlist",
    "/admins",
    "/staffing",
    "/partners",
  ]) {
    assert.equal(isUntrackedPath(path), false, path);
    assert.equal(isPanelPath(path), false, path);
  }
});

test("analytics: a blank or wrong Measurement ID keeps it off", () => {
  assert.equal(validMeasurementId("G-ABC123XYZ9"), "G-ABC123XYZ9");
  assert.equal(validMeasurementId(" G-ABC123XYZ9 "), "G-ABC123XYZ9");
  for (const bad of [
    "",
    "   ",
    undefined,
    null,
    12,
    "your-id-here",
    "UA-12345-1",
    "AW-123456",
    "G-",
    "g-abc123xyz9",
    "G-ABC123XYZ9&x=1",
  ]) {
    assert.equal(validMeasurementId(bad), null, String(bad));
  }
});

test("analytics: the reported address drops search words, sign-in details and anything after #", () => {
  const site = "https://grainbazar.com";
  assert.equal(cleanPageUrl(`${site}/`), `${site}/`);
  assert.equal(cleanPageUrl(`${site}/shop?q=rice&brand=Gold`), `${site}/shop`);
  assert.equal(cleanPageUrl(`${site}/login?next=/checkout&productId=P001`), `${site}/login`);
  assert.equal(cleanPageUrl(`${site}/checkout?coupon=WELCOME#pay`), `${site}/checkout`);
  assert.equal(
    cleanPageUrl(`${site}/reset-password?code=secret#access_token=secret`),
    `${site}/reset-password`,
  );
  assert.equal(
    cleanPageUrl(`${site}/contact?name=Ravi&phone=9876543210&email=ravi%40example.com`),
    `${site}/contact`,
  );
});

test("analytics: campaign tags survive so the owner can see where visitors came from", () => {
  const site = "https://grainbazar.com";
  assert.equal(
    cleanPageUrl(`${site}/?utm_source=instagram&utm_medium=social&q=rice`),
    `${site}/?utm_source=instagram&utm_medium=social`,
  );
  assert.equal(cleanPageUrl(`${site}/shop?gclid=abc123`), `${site}/shop?gclid=abc123`);
});

test("analytics: an empty or broken referrer reports nothing", () => {
  assert.equal(cleanPageUrl(""), "");
  assert.equal(cleanPageUrl("not a url"), "");
  assert.equal(
    cleanPageUrl("https://www.google.com/search?q=grain+bazar"),
    "https://www.google.com/search",
  );
});
