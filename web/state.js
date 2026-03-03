export function createStore(initialState) {
  let state = { ...(initialState || {}) };
  const subscribers = new Set();

  function get() {
    return state;
  }

  function set(patch) {
    state = { ...state, ...(patch || {}) };
    subscribers.forEach((fn) => fn(state));
  }

  function subscribe(fn) {
    subscribers.add(fn);
    fn(state);
    return () => subscribers.delete(fn);
  }

  return {
    get,
    set,
    subscribe,
  };
}
