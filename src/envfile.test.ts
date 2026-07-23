import { describe, expect, it } from "vitest";
import { parseEnvFile } from "./envfile.js";

describe("parseEnvFile", () => {
  it("parses keys, strips quotes, skips comments and malformed lines", () => {
    const parsed = parseEnvFile(
      [
        "# comment",
        "",
        "ANTHROPIC_API_KEY=sk-ant-123",
        'OPENAI_API_KEY="sk-quoted"',
        "GOOGLE_API_KEY='single'",
        "novalue",
        "=nokey",
        "SPACED = padded ",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-123",
      OPENAI_API_KEY: "sk-quoted",
      GOOGLE_API_KEY: "single",
      SPACED: "padded",
    });
  });

  it("keeps '=' inside values", () => {
    expect(parseEnvFile("K=a=b=c")).toEqual({ K: "a=b=c" });
  });
});
