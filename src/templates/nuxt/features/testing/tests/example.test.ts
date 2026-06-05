import { render, screen } from "@testing-library/vue";
import { describe, it, expect } from "vitest";
import { defineComponent, h } from "vue";

const Hello = defineComponent({
  props: { name: String },
  render() {
    return h("p", `Hello, ${this.name}!`);
  },
});

describe("Hello", () => {
  it("renders the name", () => {
    render(Hello, { props: { name: "World" } });
    expect(screen.getByText("Hello, World!")).toBeDefined();
  });
});
