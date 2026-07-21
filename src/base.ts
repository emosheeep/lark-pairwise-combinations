import { bitable } from "@lark-base-open/js-sdk";

import { createMockBase } from "./mock-base";

const useMock = import.meta.env.DEV && window.self === window.top;

export const base: typeof bitable.base = useMock ? createMockBase() : bitable.base;
