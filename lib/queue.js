// طابور بسيط: يحدد عدد المهام الثقيلة المتزامنة
export function createQueue(concurrency = 1) {
  let running = 0;
  const waiting = [];

  const next = () => {
    if (running >= concurrency || !waiting.length) return;
    running++;
    const { fn, resolve, reject } = waiting.shift();
    fn()
      .then(resolve, reject)
      .finally(() => {
        running--;
        next();
      });
  };

  return {
    add(fn) {
      return new Promise((resolve, reject) => {
        waiting.push({ fn, resolve, reject });
        next();
      });
    },
    get size() {
      return running + waiting.length;
    },
  };
}
