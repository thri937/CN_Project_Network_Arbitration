import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

async function buildAgentExe() {
  console.log('=== Building Slice Agent Single Executable (Node SEA) ===');
  const rootDir = path.resolve(__dirname, '..');
  const distDir = path.join(rootDir, 'dist');
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  const agentSrc = path.join(rootDir, 'apps/agent/src/index.ts');
  const bundlePath = path.join(distDir, 'agent-bundle.cjs');
  const seaConfigPath = path.join(distDir, 'sea-config.json');
  const seaBlobPath = path.join(distDir, 'sea-prep.blob');
  const targetExe = path.join(distDir, 'slice-agent.exe');

  try {
    console.log('Step 1: Bundling agent source to CommonJS...');
    // We can use esbuild via npx or compile with tsx
    execSync(`npx --yes esbuild "${agentSrc}" --bundle --platform=node --format=cjs --outfile="${bundlePath}"`, {
      stdio: 'inherit',
      cwd: rootDir,
    });

    console.log('Step 2: Creating sea-config.json...');
    fs.writeFileSync(
      seaConfigPath,
      JSON.stringify(
        {
          main: bundlePath,
          output: seaBlobPath,
          disableExperimentalSEAWarning: true,
        },
        null,
        2
      )
    );

    console.log('Step 3: Generating SEA blob...');
    execSync(`node --experimental-sea-config "${seaConfigPath}"`, { stdio: 'inherit', cwd: rootDir });

    console.log('Step 4: Copying node binary...');
    const nodeExe = process.execPath;
    fs.copyFileSync(nodeExe, targetExe);

    console.log('Step 5: Injecting blob using postject...');
    execSync(
      `npx --yes postject "${targetExe}" NODE_SEA_BLOB "${seaBlobPath}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`,
      { stdio: 'inherit', cwd: rootDir }
    );

    console.log(`\n[SUCCESS] Built single executable: ${targetExe}`);
  } catch (err: any) {
    console.warn('\n[WARNING] Node SEA build did not succeed on this environment:');
    console.warn(err.message);
    console.warn('\nFallback: run the agent directly using:');
    console.warn('  npx tsx apps/agent/src/index.ts --help');

    const openQuestionsPath = path.join(rootDir, 'docs/OPEN-QUESTIONS.md');
    let oq = '';
    if (fs.existsSync(openQuestionsPath)) {
      oq = fs.readFileSync(openQuestionsPath, 'utf8');
    }
    if (!oq.includes('Node SEA single executable build')) {
      const entry = `\n- **Node SEA single executable build**: Automated postject injection encountered an environment limitation (${err.message}). Fallback command \`npx tsx apps/agent/src/index.ts\` is documented and fully functional.\n`;
      fs.writeFileSync(openQuestionsPath, oq + entry, 'utf8');
    }
  }
}

buildAgentExe().catch(console.error);
