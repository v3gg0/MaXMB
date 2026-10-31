// The wave's rope run to its start state away from the window (sim.js, warmRopeAsync)
import { warmRope } from "./sim.js";

self.onmessage = (e) => {
  const { n, q } = e.data;
  const { cur, vel } = warmRope(n, q);
  self.postMessage({ cur, vel }, [cur.buffer, vel.buffer]);
};
