import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createHttpApp,
  isBearerAuthorized,
  normalizeMessageLimit,
  tokensMatch,
} from "../src/http.js";

const API_KEY = "0123456789abcdef0123456789abcdef";

test("compares API tokens without accepting length or value mismatches", () => {
  assert.equal(tokensMatch(API_KEY, API_KEY), true);
  assert.equal(tokensMatch(API_KEY, `${API_KEY}0`), false);
  assert.equal(tokensMatch(API_KEY, "x".repeat(API_KEY.length)), false);
  assert.equal(tokensMatch(API_KEY, ""), false);
});

test("accepts only an exact bearer credential", () => {
  assert.equal(isBearerAuthorized(API_KEY, `Bearer ${API_KEY}`), true);
  assert.equal(isBearerAuthorized(API_KEY, `bearer ${API_KEY}`), true);
  assert.equal(isBearerAuthorized(API_KEY, API_KEY), false);
  assert.equal(isBearerAuthorized(API_KEY, `Basic ${API_KEY}`), false);
  assert.equal(isBearerAuthorized(API_KEY, ""), false);
});

test("normalizes inbound body limits to a finite positive byte count", () => {
  assert.equal(normalizeMessageLimit(128.9), 128);
  assert.equal(normalizeMessageLimit("256"), 256);
  assert.equal(normalizeMessageLimit(0), 10 * 1024 * 1024);
  assert.equal(normalizeMessageLimit(Number.NaN), 10 * 1024 * 1024);
});

test("constructs the hardened HTTP app without binding a network port", () => {
  const app = createHttpApp({
    apiKey: API_KEY,
    domain: "mail.example.test",
    defaultTtlMs: 60_000,
    maxTtlMs: 120_000,
    maxMessageBytes: 128,
  });
  assert.equal(typeof app, "function");
  assert.equal(app.enabled("x-powered-by"), false);
});
