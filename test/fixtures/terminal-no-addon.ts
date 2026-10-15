/** @file Fault injection for the isolated host's unavailable-native-addon path. */
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'node-pty') {
      throw new Error('Native addon unavailable in this test process.');
    }
    return nextResolve(specifier, context);
  },
});
