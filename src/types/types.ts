export interface PendingMessage {
	userId: number;
	userName: string;
	username?: string;
	messageId: number;
	chatId: number;
	text?: string;
	contentType: string;
	media?: {
		fileId: string;
		type: 'photo' | 'video' | 'document' | 'audio';
		caption?: string;
		caption_entities?: any[];
	};
	timestamp: number;
	publishType: 'with_name' | 'anonymous' | 'pending';
	entities?: any[];
	choiceMessageId?: number; // добавлено для отслеживания сообщения с кнопками
}

export interface BotState {
	currentMessageIndex: number;
	pendingMessages: Map<number | string, PendingMessage>;
	messageQueue: PendingMessage[];
}
