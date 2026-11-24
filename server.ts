import 'dotenv/config';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Chess } from 'chess.js';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

const PORT = Number(process.env.PORT) || 3000;
const STOCKFISH_BIN = [
  path.resolve(process.cwd(), 'node_modules/stockfish/bin/stockfish-19-lite-single.js'),
  path.resolve(import.meta.dirname, 'node_modules/stockfish/bin/stockfish-19-lite-single.js'),
].find((p) => fs.existsSync(p)) ??
  path.resolve(process.cwd(), 'node_modules/stockfish/bin/stockfish-19-lite-single.js');

interface UciLineInfo {
  multipv: number;
  depth: number;
  scoreType: 'cp' | 'mate';
  scoreValue: number;
  pvUci: string[];
  pvSan: string[];
  nodes: number;
  nps: number;
  timeMs: number;
}

interface StockfishAnalysisResult {
  fen: string;
  turn: 'w' | 'b';
  isGameOver: boolean;
  isCheck: boolean;
  gameOverReason: string | null;
  bestMove: string | null;
  ponder: string | null;
  bestMoveSan: string | null;
  scoreType: 'cp' | 'mate';
  scoreValue: number;
  evaluationLabel: string;
  winProbabilityWhite: number;
  depthReached: number;
  appliedDepth: number;
  playerElo?: number;
  autoDepthByElo?: boolean;
  nodes: number;
  nps: number;
  timeMs: number;
  lines: UciLineInfo[];
  uciLog: string[];
}

function eloToSearchDepth(elo: number): number {
  const clamped = Math.max(800, Math.min(2800, Math.round(elo)));
  return Math.max(5, Math.min(18, Math.round(5 + ((clamped - 800) / 2000) * 13)));
}

function uciListToSan(fen: string, uciMoves: string[]): string[] {
  const chess = new Chess(fen);
  const sanMoves: string[] = [];
  for (const uci of uciMoves) {
    if (!uci || uci.length < 4) break;
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci[4] : undefined;
    try {
      const move = chess.move({ from, to, promotion });
      if (!move) break;
      sanMoves.push(move.san);
    } catch {
      break;
    }
  }
  return sanMoves;
}

function cpToWinProbabilityWhite(scoreType: 'cp' | 'mate', whiteVal: number): number {
  if (scoreType === 'mate') {
    if (whiteVal > 0) return 99.5;
    if (whiteVal < 0) return 0.5;
    return 50;
  }
  // Standard Lichess / logistic centipawn win probability curve
  const prob = 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * whiteVal)) - 1);
  return Math.max(0.5, Math.min(99.5, Number(prob.toFixed(1))));
}

function formatEvaluationLabel(scoreType: 'cp' | 'mate', whiteVal: number): string {
  if (scoreType === 'mate') {
    const abs = Math.abs(whiteVal);
    return whiteVal > 0 ? `+M${abs}` : `-M${abs}`;
  }
  const pawns = whiteVal / 100;
  const sign = pawns > 0 ? '+' : '';
  return `${sign}${pawns.toFixed(2)}`;
}

class StockfishUciEngine {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private initPromise: Promise<void> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private lineListeners: Set<(line: string) => void> = new Set();
  private abortListeners: Set<(err: Error) => void> = new Set();
  private buffer = '';

  private resetProcess(reason?: string) {
    const oldProc = this.proc;
    this.proc = null;
    this.ready = false;
    this.buffer = '';
    if (oldProc && !oldProc.killed) {
      try {
        oldProc.kill();
      } catch {
        // Ignore kill failures
      }
    }
    if (reason) {
      const err = new Error(reason);
      for (const rejecter of Array.from(this.abortListeners)) {
        rejecter(err);
      }
    }
  }

  private writeCommand(proc: ChildProcessWithoutNullStreams | null, command: string) {
    if (!proc || !proc.stdin || proc.stdin.destroyed || !proc.stdin.writable) {
      throw new Error('Stockfish input stream is not writable');
    }
    proc.stdin.write(`${command}\n`);
  }

  private async ensureReady(): Promise<void> {
    if (this.proc && this.ready && !this.proc.killed) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise<void>((resolve, reject) => {
      if (!fs.existsSync(STOCKFISH_BIN)) {
        reject(new Error(`Stockfish binary not found at ${STOCKFISH_BIN}`));
        return;
      }

      const proc = spawn(process.execPath, [STOCKFISH_BIN], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.proc = proc;
      this.ready = false;
      this.buffer = '';

      let settled = false;
      let gotUciOk = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        this.resetProcess();
        reject(new Error('Stockfish UCI initialization timed out'));
      }, 10000);

      const onLine = (line: string) => {
        if (line === 'uciok' && !gotUciOk) {
          gotUciOk = true;
          try {
            this.writeCommand(proc, 'setoption name MultiPV value 3');
            this.writeCommand(proc, 'isready');
          } catch (err) {
            if (!settled) {
              settled = true;
              cleanup();
              this.resetProcess();
              reject(err instanceof Error ? err : new Error('Stockfish init write failed'));
            }
          }
        } else if (line === 'readyok') {
          if (settled) return;
          settled = true;
          this.ready = true;
          cleanup();
          resolve();
        }
      };

      const onAbort = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.lineListeners.delete(onLine);
        this.abortListeners.delete(onAbort);
      };

      this.lineListeners.add(onLine);
      this.abortListeners.add(onAbort);

      proc.stdin.on('error', (err) => {
        console.error('[Stockfish stdin error]', err.message);
      });

      proc.stdout.on('data', (chunk: Buffer) => {
        this.buffer += chunk.toString('utf8');
        const lines = this.buffer.split(/\r?\n/);
        this.buffer = lines.pop() ?? '';
        for (const raw of lines) {
          const trimmed = raw.trim();
          if (!trimmed) continue;
          for (const listener of Array.from(this.lineListeners)) {
            listener(trimmed);
          }
        }
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        const msg = chunk.toString('utf8').trim();
        if (msg) console.error('[Stockfish stderr]', msg);
      });

      proc.on('error', (err) => {
        console.error('[Stockfish spawn error]', err.message);
        if (this.proc === proc) {
          this.resetProcess(`Stockfish process error: ${err.message}`);
        }
      });

      proc.on('exit', (code, signal) => {
        if (this.proc === proc) {
          this.resetProcess(`Stockfish process exited unexpectedly (code=${code}, signal=${signal})`);
        }
      });

      try {
        this.writeCommand(proc, 'uci');
      } catch (err) {
        if (!settled) {
          settled = true;
          cleanup();
          this.resetProcess();
          reject(err instanceof Error ? err : new Error('Failed to start Stockfish UCI'));
        }
      }
    });

    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  public analyze(
    fen: string,
    depth: number,
    multiPv = 3,
    playerElo?: number,
    autoDepthByElo = false
  ): Promise<StockfishAnalysisResult> {
    const runTask = async (): Promise<StockfishAnalysisResult> => {
      const chess = new Chess(fen);
      const turn = chess.turn();
      const isGameOver = chess.isGameOver();
      let gameOverReason: string | null = null;
      if (chess.isCheckmate()) {
        gameOverReason = turn === 'w' ? 'كش مات لصالح الأسود' : 'كش مات لصالح الأبيض';
      } else if (chess.isStalemate()) {
        gameOverReason = 'تعادل بالردب (Stalemate)';
      } else if (chess.isThreefoldRepetition()) {
        gameOverReason = 'تعادل بتكرار الوضعية ثلاث مرات';
      } else if (chess.isInsufficientMaterial()) {
        gameOverReason = 'تعادل لعدم كفاية القطع';
      } else if (chess.isDraw()) {
        gameOverReason = 'تعادل';
      }

      if (isGameOver) {
        const scoreVal = chess.isCheckmate() ? (turn === 'w' ? -1 : 1) : 0;
        const scoreType: 'cp' | 'mate' = chess.isCheckmate() ? 'mate' : 'cp';
        return {
          fen,
          turn,
          isGameOver: true,
          isCheck: chess.inCheck(),
          gameOverReason,
          bestMove: null,
          ponder: null,
          bestMoveSan: null,
          scoreType,
          scoreValue: scoreVal,
          evaluationLabel: chess.isCheckmate()
            ? turn === 'w'
              ? '-M0'
              : '+M0'
            : '0.00',
          winProbabilityWhite: chess.isCheckmate() ? (turn === 'w' ? 0 : 100) : 50,
          depthReached: 0,
          appliedDepth: 0,
          playerElo,
          autoDepthByElo,
          nodes: 0,
          nps: 0,
          timeMs: 0,
          lines: [],
          uciLog: [`> position fen ${fen}`, '< game over'],
        };
      }

      const executeSingleSearch = async (): Promise<StockfishAnalysisResult> => {
        await this.ensureReady();
        const activeProc = this.proc;
        if (!activeProc) throw new Error('Stockfish process unavailable');

        const safeDepth = Number.isFinite(depth) ? depth : 13;
        const safeMultiPv = Number.isFinite(multiPv) ? multiPv : 3;
        const resolvedDepth =
          autoDepthByElo && typeof playerElo === 'number' && Number.isFinite(playerElo)
            ? eloToSearchDepth(playerElo)
            : safeDepth;
        const clampedDepth = Math.max(4, Math.min(20, Math.round(resolvedDepth)));
        const clampedMultiPv = Math.max(1, Math.min(3, Math.round(safeMultiPv)));
        const uciLog: string[] = [];
        if (autoDepthByElo && typeof playerElo === 'number' && Number.isFinite(playerElo)) {
          uciLog.push(`> info string Elo ${Math.round(playerElo)} -> Auto Search Depth ${clampedDepth}`);
        }
        const pvMap = new Map<number, UciLineInfo>();
        const startTime = Date.now();

        return new Promise<StockfishAnalysisResult>((resolve, reject) => {
          let settled = false;
          const cleanup = () => {
            clearTimeout(timeout);
            this.lineListeners.delete(onLine);
            this.abortListeners.delete(onAbort);
          };

          const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            try {
              this.writeCommand(this.proc, 'stop');
            } catch {
              this.resetProcess();
            }
            cleanup();
            reject(new Error('Stockfish search timed out'));
          }, 15000);

          const onAbort = (err: Error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(err);
          };

          const onLine = (line: string) => {
          if (line.startsWith('info ')) {
            if (!line.includes(' pv ')) return;
            uciLog.push(`< ${line}`);

            const depthMatch = /\bdepth (\d+)/.exec(line);
            const multipvMatch = /\bmultipv (\d+)/.exec(line);
            const cpMatch = /\bscore cp (-?\d+)/.exec(line);
            const mateMatch = /\bscore mate (-?\d+)/.exec(line);
            const nodesMatch = /\bnodes (\d+)/.exec(line);
            const npsMatch = /\bnps (\d+)/.exec(line);
            const timeMatch = /\btime (\d+)/.exec(line);
            const pvMatch = /\bpv (.+)$/.exec(line);

            const parsedDepth = depthMatch ? Number(depthMatch[1]) : 0;
            const parsedMultiPv = multipvMatch ? Number(multipvMatch[1]) : 1;
            const pvUci = pvMatch ? pvMatch[1].trim().split(/\s+/) : [];

            let scoreType: 'cp' | 'mate' = 'cp';
            let rawScore = 0;
            if (mateMatch) {
              scoreType = 'mate';
              rawScore = Number(mateMatch[1]);
            } else if (cpMatch) {
              scoreType = 'cp';
              rawScore = Number(cpMatch[1]);
            }

            // Normalize score to White's perspective
            const whiteScore = turn === 'b' ? -rawScore : rawScore;

            pvMap.set(parsedMultiPv, {
              multipv: parsedMultiPv,
              depth: parsedDepth,
              scoreType,
              scoreValue: whiteScore,
              pvUci,
              pvSan: uciListToSan(fen, pvUci.slice(0, 6)),
              nodes: nodesMatch ? Number(nodesMatch[1]) : 0,
              nps: npsMatch ? Number(npsMatch[1]) : 0,
              timeMs: timeMatch ? Number(timeMatch[1]) : Date.now() - startTime,
            });
          } else if (line.startsWith('bestmove ')) {
            if (settled) return;
            settled = true;
            cleanup();
            uciLog.push(`< ${line}`);

            const parts = line.split(/\s+/);
            const bestMove = parts[1] && parts[1] !== '(none)' ? parts[1] : null;
            const ponderIdx = parts.indexOf('ponder');
            const ponder =
              ponderIdx !== -1 && parts[ponderIdx + 1] ? parts[ponderIdx + 1] : null;

            const sortedLines = Array.from(pvMap.values())
              .sort((a, b) => a.multipv - b.multipv)
              .slice(0, clampedMultiPv);

            const primary = sortedLines[0];
            const bestMoveSan = bestMove ? uciListToSan(fen, [bestMove])[0] ?? bestMove : null;
            const scoreType = primary?.scoreType ?? 'cp';
            const scoreValue = primary?.scoreValue ?? 0;

            resolve({
              fen,
              turn,
              isGameOver: false,
              isCheck: chess.inCheck(),
              gameOverReason: null,
              bestMove,
              ponder,
              bestMoveSan,
              scoreType,
              scoreValue,
              evaluationLabel: formatEvaluationLabel(scoreType, scoreValue),
              winProbabilityWhite: cpToWinProbabilityWhite(scoreType, scoreValue),
              depthReached: primary?.depth ?? clampedDepth,
              appliedDepth: clampedDepth,
              playerElo,
              autoDepthByElo,
              nodes: primary?.nodes ?? 0,
              nps: primary?.nps ?? 0,
              timeMs: primary?.timeMs ?? Date.now() - startTime,
              lines: sortedLines,
              uciLog: uciLog.slice(-18),
            });
          }
        };

          this.lineListeners.add(onLine);
          this.abortListeners.add(onAbort);

          const cmds = [
            `setoption name MultiPV value ${clampedMultiPv}`,
            `position fen ${fen}`,
            `go depth ${clampedDepth}`,
          ];
          try {
            for (const cmd of cmds) {
              uciLog.push(`> ${cmd}`);
              this.writeCommand(activeProc, cmd);
            }
          } catch (err) {
            if (!settled) {
              settled = true;
              cleanup();
              this.resetProcess();
              reject(err instanceof Error ? err : new Error('Failed to write UCI command'));
            }
          }
        });
      };

      try {
        return await executeSingleSearch();
      } catch (firstErr) {
        const msg = firstErr instanceof Error ? firstErr.message : '';
        if (msg.includes('exited unexpectedly') || msg.includes('not writable') || msg.includes('timed out')) {
          this.resetProcess();
          return await executeSingleSearch();
        }
        throw firstErr;
      }
    };

    const next = this.queue.then(runTask, runTask);
    this.queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}

const stockfishEngine = new StockfishUciEngine();

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('مفتاح GEMINI_API_KEY غير مضبوط في إعدادات الخادم.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function startServer() {
  const app = express();

  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.use(express.json({ limit: '4mb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.json({ ok: true, engine: 'stockfish-19-uci' });
  });

  // Stockfish UCI Analysis Endpoint (Supports both POST JSON body and GET query params)
  const DEFAULT_INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const handleStockfishAnalyze = async (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      const payload =
        req.method === 'GET'
          ? (req.query as Record<string, unknown>)
          : req.body && typeof req.body === 'object'
          ? (req.body as Record<string, unknown>)
          : {};

      const rawFen =
        typeof payload.fen === 'string' && payload.fen.trim().length > 0
          ? payload.fen.trim()
          : req.method === 'GET'
          ? DEFAULT_INITIAL_FEN
          : '';

      if (!rawFen) {
        res.status(400).json({ error: 'يجب إرسال وضعية FEN صالحة.' });
        return;
      }

      // Validate FEN with chess.js
      try {
        new Chess(rawFen);
      } catch {
        res.status(400).json({ error: 'تنسيق FEN غير صالح للتحليل.' });
        return;
      }

      const rawDepth = Number(payload.depth ?? (req.method === 'GET' ? 10 : 13));
      const safeDepth = Number.isFinite(rawDepth) ? rawDepth : 13;

      const rawMultiPv = Number(payload.multiPv ?? 3);
      const safeMultiPv = Number.isFinite(rawMultiPv) ? rawMultiPv : 3;

      const rawElo = payload.playerElo !== undefined ? Number(payload.playerElo) : undefined;
      const parsedElo =
        typeof rawElo === 'number' && Number.isFinite(rawElo) ? rawElo : undefined;

      const autoDepthByElo =
        payload.autoDepthByElo === true || payload.autoDepthByElo === 'true';

      const result = await stockfishEngine.analyze(
        rawFen,
        safeDepth,
        safeMultiPv,
        parsedElo,
        autoDepthByElo
      );
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'فشل تحليل Stockfish';
      console.error('[/api/stockfish/analyze]', message);
      res.status(500).json({ error: message });
    }
  };

  app.post('/api/stockfish/analyze', handleStockfishAnalyze);
  app.get('/api/stockfish/analyze', handleStockfishAnalyze);
  app.get('/api/stockfish', handleStockfishAnalyze);
  app.post('/api/stockfish', handleStockfishAnalyze);

  // Gemini Grandmaster Arabic Commentary Endpoint
  app.post('/api/gemini/explain', async (req: Request, res: Response) => {
    try {
      const {
        fen,
        lastMoveSan,
        lastMoveUci,
        bestMoveSan,
        bestMoveUci,
        evaluationLabel,
        turn,
        topLineSan,
        playerElo,
      } = req.body as {
        fen?: string;
        lastMoveSan?: string;
        lastMoveUci?: string;
        bestMoveSan?: string;
        bestMoveUci?: string;
        evaluationLabel?: string;
        turn?: 'w' | 'b';
        topLineSan?: string[];
        playerElo?: number;
      };

      if (!fen) {
        res.status(400).json({ error: 'الوضعية FEN مطلوبة للشرح.' });
        return;
      }

      const ai = getGeminiClient();
      const turnArabic = turn === 'w' ? 'الأبيض' : 'الأسود';
      const eloContext =
        typeof playerElo === 'number'
          ? `مستوى اللاعب المستهدف: ${Math.round(playerElo)} Elo (كيّف عمق المصطلحات التكتيكية ليناسب هذا التقييم).`
          : '';
      const prompt = [
        `الوضعية الحالية (FEN): ${fen}`,
        eloContext,
        lastMoveSan
          ? `النقلة المرصودة للتو: ${lastMoveSan} (${lastMoveUci ?? ''})`
          : 'الوضعية الابتدائية أو وضعية مخصصة.',
        `الدور الآن على: ${turnArabic}`,
        `تقييم محرك Stockfish (من منظور الأبيض): ${evaluationLabel ?? '0.00'}`,
        bestMoveSan
          ? `أفضل نقلة مقترحة من Stockfish: ${bestMoveSan} (${bestMoveUci ?? ''})`
          : 'لا توجد نقلة متاحة (نهاية الدور).',
        topLineSan && topLineSan.length > 0
          ? `التفريع الرئيسي المتوقع: ${topLineSan.join(' ')}`
          : '',
        'اشرح بإيجاز ووضوح باللغة العربية الفصحى في جملتين إلى ثلاث جمل: أثر النقلة المرصودة على التوازن التكتيكي أو السيطرة على الوسط، ولماذا تعد نقلة Stockfish المقترحة هي الرد الأمثل الآن. اكتب نصاً متصلاً قابلاً للقراءة الصوتية المباشرة بدون رموز أو قوائم أو إنجليزية زائدة.',
      ]
        .filter(Boolean)
        .join('\n');

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: prompt,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          systemInstruction:
            'أنت أستاذ كبير ومدرب شطرنج محترف تشرح تحليلات محرك Stockfish باللغة العربية الفصحى بأسلوب موجز وواضح ومناسب للإلقاء الصوتي المباشر دون علامات تنسيق أو نجوم.',
        },
      });

      const explanation = (response.text ?? '').trim();
      if (!explanation) {
        res.status(502).json({ error: 'لم يتم استلام شرح من النموذج اللغوي.' });
        return;
      }

      res.json({ explanation });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'فشل توليد الشرح التحليلي';
      console.error('[/api/gemini/explain]', message);
      res.status(500).json({ error: message });
    }
  });

  // Gemini TTS Arabic Voice Synthesis Endpoint
  app.post('/api/gemini/tts', async (req: Request, res: Response) => {
    try {
      const { text, voiceName = 'Kore' } = req.body as {
        text?: string;
        voiceName?: string;
      };

      if (!text || typeof text !== 'string' || !text.trim()) {
        res.status(400).json({ error: 'النص مطلوب للتحويل الصوتي.' });
        return;
      }

      const allowedVoices = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr'];
      const safeVoice = allowedVoices.includes(voiceName) ? voiceName : 'Kore';

      const ai = getGeminiClient();
      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash-lite-tts',
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: text.trim(),
                speechMetadata: {
                  style: 'معلق ومدرب شطرنج عربي رصين وواضح المخارج',
                },
              },
            ],
          },
        ],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: safeVoice },
            },
          },
        },
      });

      const base64Audio =
        response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

      if (!base64Audio) {
        res.status(502).json({ error: 'تعذر توليد الصوت من نموذج التحويل الصوتي.' });
        return;
      }

      res.json({
        audioBase64: base64Audio,
        mimeType: 'audio/wav',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'فشل توليد الصوت';
      console.error('[/api/gemini/tts]', message);
      res.status(500).json({ error: message });
    }
  });

  // Gemini Vision Board-to-FEN Position Scanner Endpoint
  app.post('/api/gemini/board-fen', async (req: Request, res: Response) => {
    try {
      const { imageBase64, mimeType = 'image/jpeg' } = req.body as {
        imageBase64?: string;
        mimeType?: string;
      };

      if (!imageBase64 || typeof imageBase64 !== 'string') {
        res.status(400).json({ error: 'بيانات الصورة مطلوبة لقراءة وضعية الرقعة.' });
        return;
      }

      const cleanedBase64 = imageBase64.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '');
      if (cleanedBase64.length < 100) {
        res.status(400).json({ error: 'الصورة المرسلة فارغة أو غير صالحة.' });
        return;
      }

      const ai = getGeminiClient();
      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: mimeType === 'image/png' ? 'image/png' : 'image/jpeg',
                data: cleanedBase64,
              },
            },
            {
              text: [
                'Analyze this chessboard image carefully square by square (8 rows x 8 columns).',
                'The image has already been oriented so that Rank 8 (a8..h8) is the TOP row of the 8x8 board, Rank 1 (a1..h1) is the BOTTOM row, file a is on the LEFT, and file h is on the RIGHT.',
                'Even if there is small UI margin or phone border around the grid, locate the exact 8x8 chessboard squares and read every square accurately.',
                'Use standard FEN piece letters: uppercase PNBRQK for White pieces (lighter color), lowercase pnbrqk for Black pieces (darker color), and digits 1-8 for consecutive empty squares in each rank.',
                'Return "ranks" as an array of exactly 8 strings (rank 8 first down to rank 1), where each rank string sums to exactly 8 squares.',
                'Also determine whose turn it is ("w" or "b") if visible from move highlights or active clock; default to "w" if uncertain.',
              ].join('\n'),
            },
          ],
        },
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
          systemInstruction:
            'You are a precision chess board computer-vision parser. Always inspect all 64 squares carefully and return strictly valid FEN rank strings summing to 8.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              ranks: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: 'Exactly 8 FEN rank strings from rank 8 (top) to rank 1 (bottom).',
              },
              turn: {
                type: Type.STRING,
                description: 'Side to move: "w" or "b".',
              },
              notes: {
                type: Type.STRING,
                description: 'Brief Arabic note describing the detected board state.',
              },
            },
          },
        },
      });

      const rawText = (response.text ?? '').trim();
      if (!rawText) {
        res.status(502).json({ error: 'لم يتمكن النموذج من قراءة الصورة.' });
        return;
      }

      const parsed = JSON.parse(rawText) as {
        ranks?: string[];
        turn?: string;
        notes?: string;
      };

      if (!Array.isArray(parsed.ranks) || parsed.ranks.length !== 8) {
        res.status(422).json({
          error: 'تعذر استخراج صفوف الرقعة الثمانية بدقة. قرّب الإطار الأزرق حول المربعات الـ 64 وحاول مجدداً.',
        });
        return;
      }

      // Normalize and validate each rank sums to 8
      const normalizedRanks: string[] = [];
      let whiteKings = 0;
      let blackKings = 0;
      const expandedGrid: string[][] = [];

      for (const rawRank of parsed.ranks) {
        const cleanRank = String(rawRank).trim();
        const expanded: string[] = [];
        for (const ch of cleanRank) {
          if (ch >= '1' && ch <= '8') {
            const empties = Number(ch);
            for (let k = 0; k < empties; k++) expanded.push('');
          } else if ('pnbrqkPNBRQK'.includes(ch)) {
            if (ch === 'K') whiteKings++;
            if (ch === 'k') blackKings++;
            expanded.push(ch);
          }
        }
        if (expanded.length !== 8) {
          res.status(422).json({
            error: 'تعذر محاذاة جميع الصفوف (8×8). يرجى ضبط الزوايا الأربع بدقة على حدود المربعات ثم المحاولة.',
          });
          return;
        }
        expandedGrid.push(expanded);
        // Re-encode canonical rank string
        let encoded = '';
        let emptyCount = 0;
        for (const sq of expanded) {
          if (sq === '') {
            emptyCount++;
          } else {
            if (emptyCount > 0) {
              encoded += String(emptyCount);
              emptyCount = 0;
            }
            encoded += sq;
          }
        }
        if (emptyCount > 0) encoded += String(emptyCount);
        normalizedRanks.push(encoded);
      }

      if (whiteKings !== 1 || blackKings !== 1) {
        res.status(422).json({
          error: 'لم يتم التعرف على الملكين بشكل صحيح. تأكد من شمول كامل الرقعة داخل الإطار السماوي.',
        });
        return;
      }

      const placement = normalizedRanks.join('/');

      // Infer plausible castling rights from actual king/rook positions
      let castling = '';
      if (expandedGrid[7]?.[4] === 'K') {
        if (expandedGrid[7]?.[7] === 'R') castling += 'K';
        if (expandedGrid[7]?.[0] === 'R') castling += 'Q';
      }
      if (expandedGrid[0]?.[4] === 'k') {
        if (expandedGrid[0]?.[7] === 'r') castling += 'k';
        if (expandedGrid[0]?.[0] === 'r') castling += 'q';
      }
      if (!castling) castling = '-';

      const preferredTurn: 'w' | 'b' = parsed.turn === 'b' ? 'b' : 'w';
      const candidateA = `${placement} ${preferredTurn} ${castling} - 0 1`;
      const altTurn: 'w' | 'b' = preferredTurn === 'w' ? 'b' : 'w';
      const candidateB = `${placement} ${altTurn} ${castling} - 0 1`;

      let validFen: string | null = null;
      let resolvedTurn: 'w' | 'b' = preferredTurn;

      try {
        new Chess(candidateA);
        validFen = candidateA;
        resolvedTurn = preferredTurn;
      } catch {
        try {
          new Chess(candidateB);
          validFen = candidateB;
          resolvedTurn = altTurn;
        } catch {
          validFen = null;
        }
      }

      if (!validFen) {
        res.status(422).json({
          error: 'الوضعية المقروءة غير صالحة قانونياً (ربما يوجد كش مزدوج أو بيادق في الصف الأول/الأخير). حاول ضبط الزوايا وإعادة المسح.',
        });
        return;
      }

      res.json({
        fen: validFen,
        turn: resolvedTurn,
        notes: parsed.notes ?? 'تمت قراءة الوضعية بنجاح.',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'فشلت قراءة الرقعة بالذكاء الاصطناعي.';
      console.error('[/api/gemini/board-fen]', message);
      res.status(500).json({ error: message });
    }
  });

  // Direct Standalone Single-File HTML Trainer Download Endpoint
  app.get('/api/download/single-file.html', (_req: Request, res: Response) => {
    const filePath = path.resolve(process.cwd(), 'public/chess-vision-trainer.html');
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'الملف غير موجود.' });
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="chess-vision-trainer.html"');
    res.sendFile(filePath);
  });

  // Direct Self-Contained Android Launcher ('افتح' + 3D Chessboard) HTML Download Endpoint
  app.get('/api/download/open-launcher.html', (_req: Request, res: Response) => {
    const filePath = path.resolve(process.cwd(), 'public/chess-vision-open-launcher.html');
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'الملف غير موجود.' });
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="chess-vision-open-launcher.html"');
    res.sendFile(filePath);
  });

  const buildZipBuffer = (
    files: { relPath: string; data: Buffer; mode?: number }[]
  ): Buffer => {
    const localChunks: Buffer[] = [];
    const centralChunks: Buffer[] = [];
    let offset = 0;

    for (const file of files) {
      const nameBuf = Buffer.from(file.relPath, 'utf8');
      const compressed = zlib.deflateRawSync(file.data);
      const crc = zlib.crc32(file.data) >>> 0;
      const unixMode = file.mode ?? 0o100644;

      // Local file header (30 bytes + filename)
      const localHeader = Buffer.alloc(30);
      localHeader.writeUInt32LE(0x04034b50, 0);
      localHeader.writeUInt16LE(20, 4);
      localHeader.writeUInt16LE(0x0800, 6);
      localHeader.writeUInt16LE(8, 8);
      localHeader.writeUInt16LE(0, 10);
      localHeader.writeUInt16LE(0, 12);
      localHeader.writeUInt32LE(crc, 14);
      localHeader.writeUInt32LE(compressed.length, 18);
      localHeader.writeUInt32LE(file.data.length, 22);
      localHeader.writeUInt16LE(nameBuf.length, 26);
      localHeader.writeUInt16LE(0, 28);

      localChunks.push(localHeader, nameBuf, compressed);

      // Central directory header (46 bytes + filename)
      const centralHeader = Buffer.alloc(46);
      centralHeader.writeUInt32LE(0x02014b50, 0);
      centralHeader.writeUInt16LE((3 << 8) | 20, 4); // Unix attributes + PKZIP 2.0
      centralHeader.writeUInt16LE(20, 6);
      centralHeader.writeUInt16LE(0x0800, 8);
      centralHeader.writeUInt16LE(8, 10);
      centralHeader.writeUInt16LE(0, 12);
      centralHeader.writeUInt16LE(0, 14);
      centralHeader.writeUInt32LE(crc, 16);
      centralHeader.writeUInt32LE(compressed.length, 20);
      centralHeader.writeUInt32LE(file.data.length, 24);
      centralHeader.writeUInt16LE(nameBuf.length, 28);
      centralHeader.writeUInt16LE(0, 30);
      centralHeader.writeUInt16LE(0, 32);
      centralHeader.writeUInt16LE(0, 34);
      centralHeader.writeUInt16LE(0, 36);
      centralHeader.writeUInt32LE((unixMode << 16) >>> 0, 38);
      centralHeader.writeUInt32LE(offset, 42);

      centralChunks.push(centralHeader, nameBuf);
      offset += localHeader.length + nameBuf.length + compressed.length;
    }

    const centralDir = Buffer.concat(centralChunks);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(centralDir.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);

    return Buffer.concat([...localChunks, centralDir, eocd]);
  };

  // Direct Project Source ZIP Download Endpoint
  app.get('/api/download/app.zip', (_req: Request, res: Response) => {
    try {
      const rootDir = process.cwd();
      const excludedNames = new Set([
        'node_modules',
        'dist',
        '.git',
        '.env',
        '.env.local',
        '.DS_Store',
      ]);

      const files: { relPath: string; data: Buffer; mode?: number }[] = [];
      const walk = (dir: string, prefix: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (excludedNames.has(entry.name) || entry.name.startsWith('.env.')) {
            continue;
          }
          const full = path.join(dir, entry.name);
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            walk(full, rel);
          } else if (entry.isFile()) {
            files.push({ relPath: rel, data: fs.readFileSync(full) });
          }
        }
      };
      walk(rootDir, '');

      const zipBuffer = buildZipBuffer(files);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="chess-vision-uci-app.zip"');
      res.setHeader('Content-Length', String(zipBuffer.length));
      res.send(zipBuffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'فشل تجهيز ملف التنزيل';
      console.error('[/api/download/app.zip]', message);
      res.status(500).json({ error: message });
    }
  });

  // Android Studio Kotlin WebView Launcher Project ZIP Endpoint (with Complete Gradle 8.9 Wrapper)
  app.get('/api/download/android-app.zip', (_req: Request, res: Response) => {
    try {
      const targetUrl =
        'https://ais-dev-p4xrlompq6d6vhvb2xmxjf-699178223939.europe-west2.run.app';
      const chessboardPath = path.resolve(process.cwd(), 'public/chessboard-3d.jpg');
      const chessboardData = fs.existsSync(chessboardPath)
        ? fs.readFileSync(chessboardPath)
        : Buffer.alloc(0);
      const portraitBgPath = path.resolve(
        process.cwd(),
        'public/assets/aistudio/apple-touch-icon_f4ce301f.png'
      );
      const portraitBgData = fs.existsSync(portraitBgPath)
        ? fs.readFileSync(portraitBgPath)
        : Buffer.alloc(0);
      const launcherIconPath = path.resolve(process.cwd(), 'public/pwa-192x192.png');
      const launcherIconData = fs.existsSync(launcherIconPath)
        ? fs.readFileSync(launcherIconPath)
        : portraitBgData;

      const wrapperDir = path.resolve(process.cwd(), 'tools/gradle-wrapper');
      const gradlewPath = path.join(wrapperDir, 'gradlew');
      const gradlewBatPath = path.join(wrapperDir, 'gradlew.bat');
      const wrapperJarPath = path.join(wrapperDir, 'gradle-wrapper.jar');
      const wrapperPropsPath = path.join(wrapperDir, 'gradle-wrapper.properties');

      if (
        !fs.existsSync(gradlewPath) ||
        !fs.existsSync(gradlewBatPath) ||
        !fs.existsSync(wrapperJarPath) ||
        !fs.existsSync(wrapperPropsPath)
      ) {
        res.status(500).json({ error: 'ملفات Gradle Wrapper غير مكتملة على الخادم.' });
        return;
      }

      const androidFiles: { relPath: string; data: Buffer; mode?: number }[] = [
        {
          relPath: 'ChessVisionAndroid/README.md',
          data: Buffer.from(
            [
              '# رَصْد الشطرنج — مشروع أندرويد (Kotlin + WebView + Gradle Wrapper)',
              '',
              '## المميزات المضمنة',
              '- زر كبير بارز بعنوان **"افتح"** مدمج تحته صورة رقعة شطرنج ثلاثية الأبعاد (`drawable/chessboard_3d.jpg`).',
              `- الضغط على الزر أو صورة الرقعة يفتح الرابط: ${targetUrl}`,
              '- صلاحية الكاميرا (`CAMERA`) مفعلة داخل `WebView` لدعم الرصد البصري بالذكاء الاصطناعي.',
              '- يتضمن المشروع ملفات **Gradle Wrapper 8.9** كاملة (`gradlew`, `gradlew.bat`, `gradle/wrapper/gradle-wrapper.jar`, `gradle/wrapper/gradle-wrapper.properties`).',
              '- لا يعتمد التطبيق على `google-services.json`، ويقوم مسار `.github/workflows/android.yml` بإنشاء/استعادة `debug.keystore` تلقائياً عبر `keytool` قبل التوقيع والبناء.',
              '',
              '## البناء التلقائي على GitHub Actions',
              '1. فك ضغط الملف وادخل إلى داخل مجلد `ChessVisionAndroid` (تأكد من وجود `.github` و `gradlew` في جذر المستودع).',
              '2. ارفع المحتوى إلى مستودع GitHub (`git push`).',
              '3. سيعمل مسار `.github/workflows/android.yml` تلقائياً لتوليد `debug.keystore` وتشغيل `./gradlew assembleDebug` وإخراج ملف `app-debug.apk` القابل للتثبيت في تبويب **Actions > Artifacts**.',
              '',
              '## البناء محلياً أو عبر Android Studio',
              '- افتح مجلد `ChessVisionAndroid` في **Android Studio** واختر **Build > Build APK(s)**، أو شغّل `./gradlew assembleDebug`.',
            ].join('\n'),
            'utf8'
          ),
        },
        {
          relPath: 'ChessVisionAndroid/.gitignore',
          data: Buffer.from(
            [
              '*.iml',
              '.gradle',
              '/local.properties',
              '/.idea',
              '.DS_Store',
              '/build',
              '/app/build',
              '/captures',
              '.cxx',
            ].join('\n'),
            'utf8'
          ),
        },
        {
          relPath: 'ChessVisionAndroid/gradlew',
          data: fs.readFileSync(gradlewPath),
          mode: 0o100755,
        },
        {
          relPath: 'ChessVisionAndroid/gradlew.bat',
          data: fs.readFileSync(gradlewBatPath),
        },
        {
          relPath: 'ChessVisionAndroid/gradle/wrapper/gradle-wrapper.jar',
          data: fs.readFileSync(wrapperJarPath),
        },
        {
          relPath: 'ChessVisionAndroid/gradle/wrapper/gradle-wrapper.properties',
          data: fs.readFileSync(wrapperPropsPath),
        },
        {
          relPath: 'ChessVisionAndroid/.github/workflows/android.yml',
          data: Buffer.from(
            [
              'name: Build Android APK',
              '',
              'on:',
              '  workflow_dispatch:',
              '  push:',
              '',
              'jobs:',
              '  build:',
              '    runs-on: ubuntu-latest',
              '    steps:',
              '      - name: Checkout Repository',
              '        uses: actions/checkout@v4',
              '',
              '      - name: Set up JDK 17',
              '        uses: actions/setup-java@v4',
              '        with:',
              '          distribution: temurin',
              '          java-version: "17"',
              '',
              '      - name: Setup Android SDK',
              '        uses: android-actions/setup-android@v3',
              '',
              '      - name: Restore or Generate Debug Keystore',
              '        run: |',
              '          mkdir -p "$HOME/.android"',
              '          if [ ! -f "$HOME/.android/debug.keystore" ]; then',
              '            keytool -genkeypair -v \\',
              '              -keystore "$HOME/.android/debug.keystore" \\',
              '              -storepass android \\',
              '              -alias androiddebugkey \\',
              '              -keypass android \\',
              '              -keyalg RSA \\',
              '              -keysize 2048 \\',
              '              -validity 10000 \\',
              '              -dname "CN=Android Debug,O=Android,C=US"',
              '          fi',
              '          if [ ! -f "app/debug.keystore" ]; then',
              '            cp "$HOME/.android/debug.keystore" "app/debug.keystore"',
              '          fi',
              '',
              '      - name: Setup Gradle',
              '        uses: gradle/actions/setup-gradle@v4',
              '',
              '      - name: Grant execute permission for gradlew',
              '        run: chmod +x gradlew',
              '',
              '      - name: Build Debug APK',
              '        run: ./gradlew assembleDebug --no-daemon --stacktrace',
              '',
              '      - name: Verify Installable APK Output',
              '        run: ls -lh app/build/outputs/apk/debug/app-debug.apk',
              '',
              '      - name: Upload APK Artifact',
              '        uses: actions/upload-artifact@v4',
              '        with:',
              '          name: chess-vision-debug-apk',
              '          path: app/build/outputs/apk/debug/app-debug.apk',
            ].join('\n'),
            'utf8'
          ),
        },
        {
          relPath: 'ChessVisionAndroid/settings.gradle.kts',
          data: Buffer.from(
            [
              'pluginManagement {',
              '    repositories {',
              '        google()',
              '        mavenCentral()',
              '        gradlePluginPortal()',
              '    }',
              '}',
              'dependencyResolutionManagement {',
              '    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)',
              '    repositories {',
              '        google()',
              '        mavenCentral()',
              '    }',
              '}',
              'rootProject.name = "ChessVisionAndroid"',
              'include(":app")',
            ].join('\n'),
            'utf8'
          ),
        },
        {
          relPath: 'ChessVisionAndroid/build.gradle.kts',
          data: Buffer.from(
            [
              'plugins {',
              '    id("com.android.application") version "8.6.1" apply false',
              '    id("org.jetbrains.kotlin.android") version "2.0.21" apply false',
              '}',
            ].join('\n'),
            'utf8'
          ),
        },
        {
          relPath: 'ChessVisionAndroid/gradle.properties',
          data: Buffer.from(
            [
              'org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8',
              'android.useAndroidX=true',
              'kotlin.code.style=official',
              'android.nonTransitiveRClass=true',
            ].join('\n'),
            'utf8'
          ),
        },
        {
          relPath: 'ChessVisionAndroid/app/build.gradle.kts',
          data: Buffer.from(
            [
              'plugins {',
              '    id("com.android.application")',
              '    id("org.jetbrains.kotlin.android")',
              '}',
              '',
              'android {',
              '    namespace = "com.chessvision.app"',
              '    compileSdk = 35',
              '',
              '    defaultConfig {',
              '        applicationId = "com.chessvision.app"',
              '        minSdk = 24',
              '        targetSdk = 35',
              '        versionCode = 1',
              '        versionName = "1.0"',
              '    }',
              '',
              '    signingConfigs {',
              '        getByName("debug") {',
              '            val localDebugKeystore = file("debug.keystore")',
              '            if (localDebugKeystore.exists()) {',
              '                storeFile = localDebugKeystore',
              '                storePassword = "android"',
              '                keyAlias = "androiddebugkey"',
              '                keyPassword = "android"',
              '            }',
              '        }',
              '    }',
              '',
              '    buildTypes {',
              '        debug {',
              '            signingConfig = signingConfigs.getByName("debug")',
              '        }',
              '        release {',
              '            isMinifyEnabled = false',
              '            signingConfig = signingConfigs.getByName("debug")',
              '        }',
              '    }',
              '',
              '    compileOptions {',
              '        sourceCompatibility = JavaVersion.VERSION_17',
              '        targetCompatibility = JavaVersion.VERSION_17',
              '    }',
              '    kotlinOptions {',
              '        jvmTarget = "17"',
              '    }',
              '}',
              '',
              'dependencies {',
              '    implementation("androidx.core:core-ktx:1.13.1")',
              '    implementation("androidx.activity:activity-ktx:1.9.3")',
              '    implementation("androidx.appcompat:appcompat:1.7.0")',
              '    implementation("com.google.android.material:material:1.12.0")',
              '}',
            ].join('\n'),
            'utf8'
          ),
        },
        {
          relPath: 'ChessVisionAndroid/app/src/main/AndroidManifest.xml',
          data: Buffer.from(
            [
              '<?xml version="1.0" encoding="utf-8"?>',
              '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
              '    <uses-permission android:name="android.permission.INTERNET" />',
              '    <uses-permission android:name="android.permission.CAMERA" />',
              '    <uses-feature android:name="android.hardware.camera" android:required="false" />',
              '',
              '    <application',
              '        android:allowBackup="true"',
              '        android:icon="@mipmap/ic_launcher"',
              '        android:roundIcon="@mipmap/ic_launcher_round"',
              '        android:label="@string/app_name"',
              '        android:supportsRtl="true"',
              '        android:theme="@style/Theme.ChessVision">',
              '        <activity',
              '            android:name=".MainActivity"',
              '            android:exported="true"',
              '            android:configChanges="orientation|screenSize|keyboardHidden">',
              '            <intent-filter>',
              '                <action android:name="android.intent.action.MAIN" />',
              '                <category android:name="android.intent.category.LAUNCHER" />',
              '            </intent-filter>',
              '        </activity>',
              '    </application>',
              '</manifest>',
            ].join('\n'),
            'utf8'
          ),
        },
        {
          relPath: 'ChessVisionAndroid/app/src/main/res/values/strings.xml',
          data: Buffer.from(
            [
              '<?xml version="1.0" encoding="utf-8"?>',
              '<resources>',
              '    <string name="app_name">رَصْد الشطرنج</string>',
              '    <string name="open_button">افتح</string>',
              '    <string name="board_content_desc">رقعة شطرنج ثلاثية الأبعاد</string>',
              '</resources>',
            ].join('\n'),
            'utf8'
          ),
        },
        {
          relPath: 'ChessVisionAndroid/app/src/main/res/values/themes.xml',
          data: Buffer.from(
            [
              '<?xml version="1.0" encoding="utf-8"?>',
              '<resources>',
              '    <style name="Theme.ChessVision" parent="Theme.Material3.Dark.NoActionBar">',
              '        <item name="android:statusBarColor">#0B0E14</item>',
              '        <item name="android:navigationBarColor">#0B0E14</item>',
              '        <item name="android:windowBackground">#0B0E14</item>',
              '    </style>',
              '</resources>',
            ].join('\n'),
            'utf8'
          ),
        },
        {
          relPath: 'ChessVisionAndroid/app/src/main/res/layout/activity_main.xml',
          data: Buffer.from(
            [
              '<?xml version="1.0" encoding="utf-8"?>',
              '<FrameLayout xmlns:android="http://schemas.android.com/apk/res/android"',
              '    xmlns:app="http://schemas.android.com/apk/res-auto"',
              '    android:layout_width="match_parent"',
              '    android:layout_height="match_parent"',
              '    android:background="#0B0E14"',
              '    android:layoutDirection="rtl">',
              '',
              '    <!-- خلفية التطبيق الطولية التي تغطي الشاشة بالكامل -->',
              '    <ImageView',
              '        android:id="@+id/imgAppBackground"',
              '        android:layout_width="match_parent"',
              '        android:layout_height="match_parent"',
              '        android:importantForAccessibility="no"',
              '        android:scaleType="centerCrop"',
              '        android:src="@drawable/app_bg_portrait" />',
              '',
              '    <View',
              '        android:layout_width="match_parent"',
              '        android:layout_height="match_parent"',
              '        android:background="#880B0E14" />',
              '',
              '    <!-- الشاشة الرئيسية: زر "افتح" الكبير ومدمج تحته صورة الرقعة ثلاثية الأبعاد -->',
              '    <ScrollView',
              '        android:id="@+id/launcherContainer"',
              '        android:layout_width="match_parent"',
              '        android:layout_height="match_parent"',
              '        android:fillViewport="true">',
              '',
              '        <LinearLayout',
              '            android:layout_width="match_parent"',
              '            android:layout_height="wrap_content"',
              '            android:gravity="center"',
              '            android:orientation="vertical"',
              '            android:padding="20dp">',
              '',
              '            <com.google.android.material.card.MaterialCardView',
              '                android:id="@+id/launcherCard"',
              '                android:layout_width="match_parent"',
              '                android:layout_height="wrap_content"',
              '                android:clickable="true"',
              '                android:focusable="true"',
              '                app:cardBackgroundColor="#121722"',
              '                app:cardCornerRadius="24dp"',
              '                app:cardElevation="10dp"',
              '                app:strokeColor="#10B981"',
              '                app:strokeWidth="2dp">',
              '',
              '                <LinearLayout',
              '                    android:layout_width="match_parent"',
              '                    android:layout_height="wrap_content"',
              '                    android:orientation="vertical">',
              '',
              '                    <com.google.android.material.button.MaterialButton',
              '                        android:id="@+id/btnOpen"',
              '                        android:layout_width="match_parent"',
              '                        android:layout_height="76dp"',
              '                        android:insetTop="0dp"',
              '                        android:insetBottom="0dp"',
              '                        android:text="@string/open_button"',
              '                        android:textColor="#031B13"',
              '                        android:textSize="28sp"',
              '                        android:textStyle="bold"',
              '                        app:backgroundTint="#10B981"',
              '                        app:cornerRadius="0dp" />',
              '',
              '                    <ImageView',
              '                        android:id="@+id/imgChessboard3d"',
              '                        android:layout_width="match_parent"',
              '                        android:layout_height="wrap_content"',
              '                        android:adjustViewBounds="true"',
              '                        android:clickable="true"',
              '                        android:contentDescription="@string/board_content_desc"',
              '                        android:focusable="true"',
              '                        android:scaleType="centerCrop"',
              '                        android:src="@drawable/chessboard_3d" />',
              '                </LinearLayout>',
              '            </com.google.android.material.card.MaterialCardView>',
              '        </LinearLayout>',
              '    </ScrollView>',
              '',
              '    <WebView',
              '        android:id="@+id/chessWebView"',
              '        android:layout_width="match_parent"',
              '        android:layout_height="match_parent"',
              '        android:visibility="gone" />',
              '',
              '    <ProgressBar',
              '        android:id="@+id/loadingProgress"',
              '        android:layout_width="wrap_content"',
              '        android:layout_height="wrap_content"',
              '        android:layout_gravity="center"',
              '        android:visibility="gone" />',
              '</FrameLayout>',
            ].join('\n'),
            'utf8'
          ),
        },
        {
          relPath: 'ChessVisionAndroid/app/src/main/java/com/chessvision/app/MainActivity.kt',
          data: Buffer.from(
            [
              'package com.chessvision.app',
              '',
              'import android.Manifest',
              'import android.annotation.SuppressLint',
              'import android.content.pm.PackageManager',
              'import android.net.Uri',
              'import android.os.Bundle',
              'import android.view.View',
              'import android.webkit.CookieManager',
              'import android.webkit.PermissionRequest',
              'import android.webkit.ValueCallback',
              'import android.webkit.WebChromeClient',
              'import android.webkit.WebResourceRequest',
              'import android.webkit.WebView',
              'import android.webkit.WebViewClient',
              'import android.widget.ImageView',
              'import android.widget.ProgressBar',
              'import android.widget.ScrollView',
              'import androidx.activity.OnBackPressedCallback',
              'import androidx.activity.result.contract.ActivityResultContracts',
              'import androidx.appcompat.app.AppCompatActivity',
              'import androidx.core.content.ContextCompat',
              'import com.google.android.material.button.MaterialButton',
              'import com.google.android.material.card.MaterialCardView',
              '',
              'class MainActivity : AppCompatActivity() {',
              `    private val targetUrl = "${targetUrl}"`,
              '    private lateinit var launcherContainer: ScrollView',
              '    private lateinit var chessWebView: WebView',
              '    private lateinit var loadingProgress: ProgressBar',
              '    private var pendingWebPermission: PermissionRequest? = null',
              '    private var filePathCallback: ValueCallback<Array<Uri>>? = null',
              '    private var hasLoadedUrl = false',
              '',
              '    private val cameraPermissionLauncher =',
              '        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->',
              '            pendingWebPermission?.let { req ->',
              '                if (granted) req.grant(req.resources) else req.deny()',
              '                pendingWebPermission = null',
              '            }',
              '            openChessVisionUrl()',
              '        }',
              '',
              '    private val imagePickerLauncher =',
              '        registerForActivityResult(ActivityResultContracts.GetContent()) { uri: Uri? ->',
              '            filePathCallback?.onReceiveValue(if (uri != null) arrayOf(uri) else null)',
              '            filePathCallback = null',
              '        }',
              '',
              '    @SuppressLint("SetJavaScriptEnabled")',
              '    override fun onCreate(savedInstanceState: Bundle?) {',
              '        super.onCreate(savedInstanceState)',
              '        setContentView(R.layout.activity_main)',
              '',
              '        launcherContainer = findViewById(R.id.launcherContainer)',
              '        chessWebView = findViewById(R.id.chessWebView)',
              '        loadingProgress = findViewById(R.id.loadingProgress)',
              '',
              '        val launcherCard: MaterialCardView = findViewById(R.id.launcherCard)',
              '        val btnOpen: MaterialButton = findViewById(R.id.btnOpen)',
              '        val imgBoard: ImageView = findViewById(R.id.imgChessboard3d)',
              '',
              '        CookieManager.getInstance().apply {',
              '            setAcceptCookie(true)',
              '            setAcceptThirdPartyCookies(chessWebView, true)',
              '        }',
              '',
              '        chessWebView.settings.apply {',
              '            javaScriptEnabled = true',
              '            domStorageEnabled = true',
              '            useWideViewPort = true',
              '            loadWithOverviewMode = true',
              '            allowContentAccess = true',
              '            allowFileAccess = true',
              '            mediaPlaybackRequiresUserGesture = false',
              '        }',
              '        chessWebView.webViewClient = object : WebViewClient() {',
              '            override fun shouldOverrideUrlLoading(',
              '                view: WebView?,',
              '                request: WebResourceRequest?',
              '            ): Boolean {',
              '                return false',
              '            }',
              '',
              '            override fun onPageFinished(view: WebView?, url: String?) {',
              '                loadingProgress.visibility = View.GONE',
              '            }',
              '        }',
              '        chessWebView.webChromeClient = object : WebChromeClient() {',
              '            override fun onPermissionRequest(request: PermissionRequest) {',
              '                runOnUiThread {',
              '                    val hasCam = ContextCompat.checkSelfPermission(',
              '                        this@MainActivity,',
              '                        Manifest.permission.CAMERA',
              '                    ) == PackageManager.PERMISSION_GRANTED',
              '                    if (hasCam) {',
              '                        request.grant(request.resources)',
              '                    } else {',
              '                        pendingWebPermission = request',
              '                        cameraPermissionLauncher.launch(Manifest.permission.CAMERA)',
              '                    }',
              '                }',
              '            }',
              '',
              '            override fun onShowFileChooser(',
              '                webView: WebView?,',
              '                callback: ValueCallback<Array<Uri>>?,',
              '                fileChooserParams: FileChooserParams?',
              '            ): Boolean {',
              '                filePathCallback?.onReceiveValue(null)',
              '                filePathCallback = callback',
              '                return try {',
              '                    imagePickerLauncher.launch("image/*")',
              '                    true',
              '                } catch (_: Exception) {',
              '                    filePathCallback = null',
              '                    false',
              '                }',
              '            }',
              '        }',
              '',
              '        val launchAction = View.OnClickListener { handleOpenClicked() }',
              '        launcherCard.setOnClickListener(launchAction)',
              '        btnOpen.setOnClickListener(launchAction)',
              '        imgBoard.setOnClickListener(launchAction)',
              '',
              '        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {',
              '            override fun handleOnBackPressed() {',
              '                if (chessWebView.visibility == View.VISIBLE) {',
              '                    if (chessWebView.canGoBack()) {',
              '                        chessWebView.goBack()',
              '                    } else {',
              '                        chessWebView.visibility = View.GONE',
              '                        loadingProgress.visibility = View.GONE',
              '                        launcherContainer.visibility = View.VISIBLE',
              '                    }',
              '                } else {',
              '                    isEnabled = false',
              '                    onBackPressedDispatcher.onBackPressed()',
              '                }',
              '            }',
              '        })',
              '    }',
              '',
              '    private fun handleOpenClicked() {',
              '        val hasCam = ContextCompat.checkSelfPermission(',
              '            this,',
              '            Manifest.permission.CAMERA',
              '        ) == PackageManager.PERMISSION_GRANTED',
              '        if (!hasCam) {',
              '            cameraPermissionLauncher.launch(Manifest.permission.CAMERA)',
              '        } else {',
              '            openChessVisionUrl()',
              '        }',
              '    }',
              '',
              '    private fun openChessVisionUrl() {',
              '        launcherContainer.visibility = View.GONE',
              '        chessWebView.visibility = View.VISIBLE',
              '        if (!hasLoadedUrl) {',
              '            hasLoadedUrl = true',
              '            loadingProgress.visibility = View.VISIBLE',
              '            chessWebView.loadUrl(targetUrl)',
              '        } else {',
              '            loadingProgress.visibility = View.GONE',
              '        }',
              '    }',
              '}',
            ].join('\n'),
            'utf8'
          ),
        },
      ];

      if (chessboardData.length > 0) {
        androidFiles.push({
          relPath: 'ChessVisionAndroid/app/src/main/res/drawable/chessboard_3d.jpg',
          data: chessboardData,
        });
      }
      if (portraitBgData.length > 0) {
        androidFiles.push({
          relPath: 'ChessVisionAndroid/app/src/main/res/drawable/app_bg_portrait.png',
          data: portraitBgData,
        });
      }
      if (launcherIconData.length > 0) {
        for (const dpi of ['mipmap-hdpi', 'mipmap-xhdpi', 'mipmap-xxhdpi', 'mipmap-xxxhdpi']) {
          androidFiles.push({
            relPath: `ChessVisionAndroid/app/src/main/res/${dpi}/ic_launcher.png`,
            data: launcherIconData,
          });
          androidFiles.push({
            relPath: `ChessVisionAndroid/app/src/main/res/${dpi}/ic_launcher_round.png`,
            data: launcherIconData,
          });
        }
      }

      const zipBuffer = buildZipBuffer(androidFiles);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="chess-vision-android-app.zip"');
      res.setHeader('Content-Length', String(zipBuffer.length));
      res.send(zipBuffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'فشل تجهيز مشروع الأندرويد';
      console.error('[/api/download/android-app.zip]', message);
      res.status(500).json({ error: message });
    }
  });

  // Ensure any unmatched /api/* route or body-parser error always returns JSON (never HTML)
  app.all('/api/*', (_req: Request, res: Response) => {
    res.status(404).setHeader('Content-Type', 'application/json; charset=utf-8').json({
      error: 'نقطة النهاية المطلوبة غير موجودة.',
    });
  });

  app.use('/api', (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const errObj = err as { status?: number; type?: string; message?: string } | null;
    const status =
      typeof errObj?.status === 'number' && errObj.status >= 400 && errObj.status < 600
        ? errObj.status
        : 400;
    const message =
      errObj?.type === 'entity.parse.failed'
        ? 'بيانات JSON المرسلة غير صالحة.'
        : errObj?.type === 'entity.too.large'
        ? 'حجم البيانات المرسلة يتجاوز الحد المسموح.'
        : errObj?.message || 'حدث خطأ في خادم التحليل.';
    res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8').json({
      error: message,
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build output not found.');
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ChessVision UCI server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
