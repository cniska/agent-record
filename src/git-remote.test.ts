import { describe, expect, test } from "bun:test";
import { repositoryLabel } from "./git-remote";

describe("repositoryLabel", () => {
  test("names the same repository however it is addressed", () => {
    const expected = "acme/widgets";
    expect(repositoryLabel("git@github.com:acme/widgets.git")).toBe(expected);
    expect(repositoryLabel("https://github.com/acme/widgets.git")).toBe(expected);
    expect(repositoryLabel("https://github.com/acme/widgets")).toBe(expected);
    expect(repositoryLabel("ssh://git@github.com:22/acme/widgets.git")).toBe(expected);
    expect(repositoryLabel("https://gitlab.com/acme/widgets.git")).toBe(expected);
  });

  test("keeps nested owners rather than truncating to two segments", () => {
    expect(repositoryLabel("https://gitlab.com/group/sub/thing.git")).toBe("group/sub/thing");
  });

  test("lowercases, so one repository is not two", () => {
    expect(repositoryLabel("git@github.com:Acme/Widgets.git")).toBe("acme/widgets");
  });

  test("returns null for an address that names no shared repository", () => {
    expect(repositoryLabel("/Users/x/code/widgets")).toBeNull();
    expect(repositoryLabel("../sibling")).toBeNull();
    expect(repositoryLabel("C:/code/widgets")).toBeNull();
    expect(repositoryLabel("github.com/onlyowner")).toBeNull();
  });
});
