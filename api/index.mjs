import { createHandler } from '../server/index.mjs';
let handler;
export default (request, response) => {
  handler ??= createHandler();
  return handler(request, response);
};
