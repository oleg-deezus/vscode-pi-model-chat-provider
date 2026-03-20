/**
 * Session Pool - Manages multiple Pi RPC sessions for conversation isolation
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { PiBridge } from './pi-bridge.js';
import type { PiConfig } from './types.js';
import { debug } from './debug.js';

interface SessionState {
    bridge: PiBridge;
    messageCount: number;
    lastActivity: number;
    modelId: string;
}

export class SessionPool {
    private sessions = new Map<string, SessionState>();
    private idleCheckInterval: NodeJS.Timeout | null = null;
    private statusBar: vscode.StatusBarItem | undefined;
    private statusBarHideTimer: NodeJS.Timeout | undefined;
    private modelCache: any[] | null = null;  // Cache available models to avoid repeated Pi startups
    private metadataBridge: PiBridge | null = null;  // Persistent bridge for model enumeration
    private pendingContext: string = '';  // Store context for potential multi-message scenarios

    constructor(
        private config: PiConfig,
        private maxSessions: number = 20,
        private idleTimeoutMs: number = 600_000  // 10 minutes
    ) {
        // Start idle session cleanup task
        this.idleCheckInterval = setInterval(() => this.cleanupIdleSessions(), 60_000);
    }

    async getOrCreate(
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        modelId: string
    ): Promise<{ bridge: PiBridge; isNew: boolean; newMessages: string[] }> {
        debug('[SessionPool] ========================================');
        debug('[SessionPool] getOrCreate called with:', {
            totalMessages: messages.length,
            messageRoles: messages.map(m => m.role)
        });

        // Extract user messages only (VS Code includes assistant responses)
        const userMessages = messages.filter(
            m => m.role === vscode.LanguageModelChatMessageRole.User
        );

        debug('[SessionPool] User messages:', {
            count: userMessages.length,
            previews: userMessages.map(m => this.extractText(m).substring(0, 50))
        });

        if (userMessages.length === 0) {
            throw new Error('No user messages found');
        }

        // Extract text from all user messages and filter out empty ones
        const allMessageTexts = userMessages.map(msg => this.extractText(msg));
        const nonEmptyMessages = allMessageTexts.filter(text => text.length > 0);

        debug('[SessionPool] Found messages with user queries:', nonEmptyMessages.length);

        // Compute hash of user message history (excluding the new message)
        const historyHash = this.computeHistoryHash(userMessages.slice(0, -1), modelId);
        const lastUserMsg = nonEmptyMessages[nonEmptyMessages.length - 1];

        debug('[SessionPool] Session detection:', {
            historyHash,
            historySizeUsed: userMessages.length - 1,
            activeSessions: this.sessions.size,
            allHashes: Array.from(this.sessions.keys())
        });

        const existing = this.sessions.get(historyHash);
        
        if (existing && userMessages.length > existing.messageCount) {
            // Continuation: same history, new user message appended
            debug('[SessionPool] ✓ CONTINUATION detected:', {
                existingMessageCount: existing.messageCount,
                currentMessageCount: userMessages.length,
                willSendMessages: 1
            });

            existing.messageCount = userMessages.length;
            existing.lastActivity = Date.now();
            
            // Update hash to include the new message for next turn
            const updatedHash = this.computeHistoryHash(userMessages, modelId);
            if (updatedHash !== historyHash) {
                this.sessions.delete(historyHash);
                this.sessions.set(updatedHash, existing);
                debug('[SessionPool] Session hash updated:', historyHash, '->', updatedHash);
            }
            
            return {
                bridge: existing.bridge,
                isNew: false,
                newMessages: [lastUserMsg]  // Only the new message
            };
        }

        // New conversation or history changed (edit, branch, etc.)
        debug('[SessionPool] ⭐ NEW SESSION will be created:', {
            reason: existing 
                ? `message count mismatch (existing: ${existing.messageCount}, current: ${userMessages.length})` 
                : 'no existing session with this history',
            willSendMessages: nonEmptyMessages.length
        });
        // Check pool size and evict if needed
        if (this.sessions.size >= this.maxSessions) {
            this.evictLRU();
        }

        // Create new session
        const bridge = new PiBridge(this.config);
        await bridge.ensureStarted();
        
        // Call new_session to reset Pi's conversation state
        await bridge.newSession();
        
        // Store session with hash of ALL user messages (for next turn's comparison)
        const fullHistoryHash = this.computeHistoryHash(userMessages, modelId);
        this.sessions.set(fullHistoryHash, {
            bridge,
            messageCount: userMessages.length,
            lastActivity: Date.now(),
            modelId
        });

        debug('[SessionPool] New session stored:', {
            hash: fullHistoryHash,
            messageCount: userMessages.length,
            totalSessions: this.sessions.size
        });

        // For new conversations, use all non-empty messages
        return { bridge, isNew: true, newMessages: nonEmptyMessages };
    }

    async updateStatusBar(bridge: PiBridge): Promise<void> {
        try {
            debug('[SessionPool] Updating status bar...');
            
            const [stats, state] = await Promise.all([
                bridge.getSessionStats(),
                bridge.getState()
            ]);

            debug('[SessionPool] Stats:', stats);
            debug('[SessionPool] State:', state);

            const contextWindow = state.model?.contextWindow || 200000;
            const totalTokens = stats.tokens?.total || 0;
            const utilization = Math.round((totalTokens / contextWindow) * 100);

            this.ensureStatusBar();
            
            // Short text: custom Pi icon + percentage
            // Falls back to π emoji if font file not available
            this.statusBar!.text = `$(pi-logo) ${utilization}%`;
            
            debug('[SessionPool] Status bar text set to:', this.statusBar!.text);
            
            // Detailed tooltip
            const tooltipLines = [
                `Pi Context Utilization`,
                `━━━━━━━━━━━━━━━━━━━━`,
                `Used: ${this.formatTokens(totalTokens)} / ${this.formatTokens(contextWindow)} (${utilization}%)`,
                ``,
                `Breakdown:`,
                `  Input: ${this.formatTokens(stats.tokens?.input || 0)}`,
                `  Output: ${this.formatTokens(stats.tokens?.output || 0)}`,
                `  Cached: ${this.formatTokens(stats.tokens?.cacheRead || 0)}`,
                ``,
                `Sessions: ${this.sessions.size} / ${this.maxSessions}`,
                `Messages: ${stats.userMessages || 0} user, ${stats.assistantMessages || 0} assistant`,
                `Cost: $${stats.cost?.toFixed(4) || '0.0000'}`,
            ];

            if (state.isCompacting) {
                tooltipLines.push(``, `⚠️ Compacting context...`);
            }

            this.statusBar!.tooltip = tooltipLines.join('\n');
            this.statusBar!.show();
            debug('[SessionPool] Status bar shown!');

            // Auto-hide after 5 minutes of inactivity
            this.resetStatusBarHideTimer();
        } catch (error) {
            console.error('[SessionPool] Failed to update status bar:', error);
            console.error('[SessionPool] Error details:', error);
        }
    }

    private ensureStatusBar(): void {
        if (!this.statusBar) {
            debug('[SessionPool] Creating status bar item...');
            this.statusBar = vscode.window.createStatusBarItem(
                vscode.StatusBarAlignment.Right,
                100
            );
            this.statusBar.name = 'Pi Context';
            debug('[SessionPool] Status bar item created');
        }
    }

    private resetStatusBarHideTimer(): void {
        if (this.statusBarHideTimer) {
            clearTimeout(this.statusBarHideTimer);
        }
        
        this.statusBarHideTimer = setTimeout(() => {
            this.statusBar?.hide();
        }, 5 * 60 * 1000); // 5 minutes
    }

    private formatTokens(tokens: number): string {
        if (tokens >= 1000) {
            return `${(tokens / 1000).toFixed(1)}k`;
        }
        return tokens.toString();
    }

    private computeHistoryHash(
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        modelId: string
    ): string {
        // Hash user message history + model ID for session identification
        // Filter out messages with no text content
        const content = messages
            .map(m => {
                const text = this.extractText(m);
                return text ? `${m.role}:${text}` : '';
            })
            .filter(s => s.length > 0)
            .join('|')
            + `|${modelId}`;
        
        return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
    }

    private evictLRU(): void {
        let oldestHash: string | null = null;
        let oldestTime = Date.now();

        for (const [hash, state] of this.sessions.entries()) {
            if (state.lastActivity < oldestTime) {
                oldestTime = state.lastActivity;
                oldestHash = hash;
            }
        }

        if (oldestHash) {
            const state = this.sessions.get(oldestHash)!;
            state.bridge.shutdown();
            this.sessions.delete(oldestHash);
            debug('[SessionPool] Evicted LRU session:', oldestHash);
        }
    }

    private cleanupIdleSessions(): void {
        const now = Date.now();
        const toRemove: string[] = [];

        for (const [hash, state] of this.sessions.entries()) {
            if (now - state.lastActivity > this.idleTimeoutMs) {
                state.bridge.shutdown();
                toRemove.push(hash);
            }
        }

        for (const hash of toRemove) {
            this.sessions.delete(hash);
            debug('[SessionPool] Cleaned up idle session:', hash);
        }
    }

    private extractText(message: vscode.LanguageModelChatRequestMessage): string {
        const textParts: string[] = [];
        
        for (const part of message.content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                textParts.push(part.value);
            }
        }

        if (textParts.length === 0) {
            // Message has no text (might be image-only or empty)
            debug('[SessionPool] Warning: Message contains no text content');
            return '';
        }

        let fullText = textParts.join('\n');

        debug('[SessionPool] extractText - raw text:', {
            length: fullText.length,
            preview: fullText.substring(0, 500),
            hasPromptTags: fullText.includes('<prompt>'),
            hasUserQueryTags: fullText.includes('<user_query>')
        });

        // VS Code may or may not include <user_query> tags depending on the model:
        // - Copilot models: include <user_query> tags
        // - Other models (Pi, Ollama, etc.): don't include these tags
        if (!fullText.includes('<user_query>')) {
            // No tags - might be context-only or non-Copilot model
            // Store for potential combination with next message
            debug('[SessionPool] extractText - No <user_query> tags found, returning full text');
            this.pendingContext = fullText;
            return fullText;
        }

        // Has tags - extract user query (for Copilot models)
        const userQueryMatch = fullText.match(/<user_query>([\s\S]*?)<\/user_query>/);
        if (userQueryMatch) {
            let result = userQueryMatch[1].trim();
            // Combine with any pending context
            if (this.pendingContext) {
                debug('[SessionPool] extractText - PREPENDING stored context to user query');
                result = this.pendingContext + '\n' + result;
                this.pendingContext = '';
            }
            debug('[SessionPool] extractText - sending to Pi:', {
                length: result.length,
                hasPendingContext: result !== userQueryMatch[1].trim()
            });
            return result;
        }

        return fullText;
    }

    async getAvailableModels(): Promise<any[]> {
        // Return cached models if available
        if (this.modelCache) {
            debug('[SessionPool] Returning cached models:', this.modelCache.length);
            return this.modelCache;
        }

        debug('[SessionPool] No cache - querying Pi for models...');
        
        // Try to reuse an existing session's bridge to avoid creating a new Pi process
        const existingBridge = this.sessions.size > 0 
            ? Array.from(this.sessions.values())[0].bridge 
            : null;
        
        let bridge: PiBridge;
        
        if (existingBridge) {
            debug('[SessionPool] Reusing existing session bridge for model enumeration');
            bridge = existingBridge;
        } else {
            // No existing sessions - create a persistent metadata bridge
            // We keep this bridge alive to avoid the 30-second shutdown delay
            if (!this.metadataBridge) {
                debug('[SessionPool] Creating persistent metadata bridge...');
                this.metadataBridge = new PiBridge(this.config);
                await this.metadataBridge.ensureStarted();
            }
            bridge = this.metadataBridge;
        }
        
        const models = await bridge.getAvailableModels();
        
        // Cache the result
        this.modelCache = models;
        debug('[SessionPool] Models cached:', models.length);
        
        return models;
    }

    async dispose(): Promise<void> {
        // Clear intervals and timers
        if (this.idleCheckInterval) {
            clearInterval(this.idleCheckInterval);
            this.idleCheckInterval = null;
        }
        
        if (this.statusBarHideTimer) {
            clearTimeout(this.statusBarHideTimer);
            this.statusBarHideTimer = undefined;
        }

        // Clear model cache
        this.modelCache = null;

        // Dispose status bar
        if (this.statusBar) {
            this.statusBar.dispose();
            this.statusBar = undefined;
        }

        // Shutdown metadata bridge if it exists
        if (this.metadataBridge) {
            await this.metadataBridge.shutdown();
            this.metadataBridge = null;
        }

        // Shutdown all sessions
        const shutdownPromises = Array.from(this.sessions.values()).map(
            state => state.bridge.shutdown()
        );

        await Promise.all(shutdownPromises);
        this.sessions.clear();
        debug('[SessionPool] Disposed all sessions');
    }
}
