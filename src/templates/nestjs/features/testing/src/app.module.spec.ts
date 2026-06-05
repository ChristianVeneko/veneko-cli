import { Test } from "@nestjs/testing";
import { AppModule } from "./app.module.js";
import { describe, it, expect, beforeAll } from "vitest";

describe("AppModule", () => {
  it("compiles the module", async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    expect(module).toBeDefined();
  });
});
