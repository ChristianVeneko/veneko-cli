import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";

function Hello({ name }: { name: string }) {
  return <p>Hello, {name}!</p>;
}

describe("Hello", () => {
  it("renders the name", () => {
    render(<Hello name="World" />);
    expect(screen.getByText("Hello, World!")).toBeDefined();
  });
});
