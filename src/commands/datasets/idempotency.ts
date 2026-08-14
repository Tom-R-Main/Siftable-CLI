import {Flags} from '@oclif/core';

export const datasetIdempotencyKeyFlag = Flags.string({
  description: 'Caller-owned stable key for replaying this exact dataset mutation',
  required: true,
});
