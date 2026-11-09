// jest-dom adds custom jest matchers for asserting on DOM nodes.
// allows you to do things like:
// expect(element).toHaveTextContent(/react/i)
// learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom';

// jsdom lacks TextEncoder/TextDecoder, which the Sapphire wrapper's CBOR dependency needs.
const { TextEncoder: NodeTextEncoder, TextDecoder: NodeTextDecoder } = require("util");
if (!global.TextEncoder) global.TextEncoder = NodeTextEncoder;
if (!global.TextDecoder) global.TextDecoder = NodeTextDecoder;
