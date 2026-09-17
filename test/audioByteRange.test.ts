import { describe, expect, it } from "vitest";
import { parseSingleByteRange } from "../src/server/audioByteRange";

describe("parseSingleByteRange", () => {
  it("parses bounded, open-ended and suffix ranges", () => {
    expect(parseSingleByteRange("bytes=2-5", 10)).toEqual({ start: 2, end: 5 });
    expect(parseSingleByteRange("bytes=7-", 10)).toEqual({ start: 7, end: 9 });
    expect(parseSingleByteRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(parseSingleByteRange("bytes=-20", 10)).toEqual({ start: 0, end: 9 });
    expect(parseSingleByteRange("bytes=8-99", 10)).toEqual({ start: 8, end: 9 });
  });

  it("rejects malformed, unsatisfiable and multiple ranges", () => {
    expect(parseSingleByteRange("bytes=10-", 10)).toBeUndefined();
    expect(parseSingleByteRange("bytes=7-6", 10)).toBeUndefined();
    expect(parseSingleByteRange("bytes=-0", 10)).toBeUndefined();
    expect(parseSingleByteRange("bytes=0-1,4-5", 10)).toBeUndefined();
    expect(parseSingleByteRange("items=0-1", 10)).toBeUndefined();
    expect(parseSingleByteRange("bytes=0-1", 0)).toBeUndefined();
  });
});
