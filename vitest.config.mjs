import { defineConfig } from 'vitest/config';
export default defineConfig({test:{include:['test/**/*.test.mjs'],exclude:['test/stress/**'],pool:'forks',maxWorkers:2,minWorkers:1,testTimeout:20000,hookTimeout:20000,fileParallelism:false}});
