// Test helper: fake readOnlyCall / readOnlyBatchCall backed by one handler(method, args) -> value (throw = revert).
const factoryProxy = {
  methods: new Proxy({}, {
    get: (_, method) => (...args) => ({ method, args, call: { request: () => ({ method, args }) } }),
  }),
};

export const chainImplementations = (handle) => ({
  call: async (fn) => {
    const spec = fn({ factory: factoryProxy });
    return handle(spec.method, spec.args);
  },
  batch: async (build) => build({ factory: factoryProxy }).map((item) => {
    const spec = item.request(() => {});
    try {
      return { status: "fulfilled", value: handle(spec.method, spec.args) };
    } catch (reason) {
      return { status: "rejected", reason };
    }
  }),
});
