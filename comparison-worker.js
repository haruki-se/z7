import {compareAudio} from './comparison.js';
self.onmessage = ({data}) => {
  try {
    const result = compareAudio(data, percent => self.postMessage({type: 'progress', percent}));
    self.postMessage({type: 'result', result});
  } catch (error) { self.postMessage({type: 'error', message: error.message}); }
};
