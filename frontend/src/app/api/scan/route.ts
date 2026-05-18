import { NextResponse } from 'next/server';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';

export async function POST(req: Request) {
  try {
    const { url } = await req.json();

    if (!url) {
      return NextResponse.json({ error: 'URL is required' }, { status: 400 });
    }

    const runId = randomUUID();
    const outputDir = path.join(process.cwd(), 'output', runId);

    // Determine path to blob-unpacker
    // Assuming frontend is adjacent to blob-unpacker
    const unpackerPath = path.resolve(process.cwd(), '../blob-unpacker/src/index.ts');
    
    // Create a promise to handle the spawn
    return new Promise<NextResponse>((resolve) => {
      const child = spawn('npx', ['ts-node', unpackerPath, url, '-o', outputDir, '--quick'], {
        cwd: path.resolve(process.cwd(), '../blob-unpacker'),
      });

      let stdoutData = '';
      let stderrData = '';

      child.stdout.on('data', (data) => {
        stdoutData += data.toString();
        console.log(`[BlobUnpacker] ${data.toString()}`);
      });

      child.stderr.on('data', (data) => {
        stderrData += data.toString();
        console.error(`[BlobUnpacker ERROR] ${data.toString()}`);
      });

      child.on('close', (code) => {
        if (code !== 0) {
          resolve(NextResponse.json({ error: 'Failed to run pipeline', details: stderrData }, { status: 500 }));
          return;
        }

        // Read results
        try {
          const parsedUrl = new URL(url);
          const hostDir = path.join(outputDir, parsedUrl.hostname);
          
          let endpoints = [];
          let secrets = [];
          let comments = [];
          
          if (fs.existsSync(path.join(hostDir, 'endpoints.json'))) {
             endpoints = JSON.parse(fs.readFileSync(path.join(hostDir, 'endpoints.json'), 'utf-8'));
          }
          if (fs.existsSync(path.join(hostDir, 'secrets.json'))) {
             secrets = JSON.parse(fs.readFileSync(path.join(hostDir, 'secrets.json'), 'utf-8'));
          }
          if (fs.existsSync(path.join(hostDir, 'comments.json'))) {
             comments = JSON.parse(fs.readFileSync(path.join(hostDir, 'comments.json'), 'utf-8'));
          }

          resolve(NextResponse.json({
            success: true,
            runId,
            results: {
              endpoints,
              secrets,
              comments
            },
            logs: stdoutData
          }));
        } catch (e: any) {
          resolve(NextResponse.json({ error: 'Failed to read results', details: e.message }, { status: 500 }));
        }
      });
    });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
