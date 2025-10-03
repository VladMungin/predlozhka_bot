import {Context, Markup, Telegraf} from 'telegraf';
import {Update} from 'telegraf/typings/core/types/typegram';
import * as dotenv from 'dotenv';
import {BotState, PendingMessage} from './types';

dotenv.config();

// Кастомный интерфейс контекста с callback_query
interface MyContext extends Context {
	update: Update;
}

class MessageReviewBot {
	private bot: Telegraf<MyContext>;
	private state: BotState;
	private botUsername: string;

	constructor() {
		const token = process.env.BOT_TOKEN;
		if (!token) {
			throw new Error('BOT_TOKEN is required');
		}

		this.botUsername = process.env.BOT_USERNAME!;
		if (!this.botUsername) {
			throw new Error('BOT_USERNAME is required');
		}

		this.bot = new Telegraf<MyContext>(token);
		this.state = {
			currentMessageIndex: 0,
			pendingMessages: new Map(),
			messageQueue: []
		};

		this.setupHandlers();
	}

	private setupHandlers(): void {
		// Команда старт
		this.bot.start(this.handleStart.bind(this));

		// Обработка текстовых сообщений
		this.bot.on('text', this.handleUserMessage.bind(this));

		// Обработка медиа-сообщений
		this.bot.on('photo', this.handleUserMessage.bind(this));
		this.bot.on('video', this.handleUserMessage.bind(this));
		this.bot.on('document', this.handleUserMessage.bind(this));
		this.bot.on('audio', this.handleUserMessage.bind(this));

		// Обработка callback-запросов (кнопки выбора типа публикации) как middleware
		this.bot.use(this.handleUserChoice.bind(this));

		// Обработка callback-запросов админа - РАЗДЕЛЕНЫ ОБРАБОТЧИКИ
		this.bot.action('admin_approve', this.handleAdminCallback.bind(this));
		this.bot.action('admin_reject', this.handleAdminCallback.bind(this));
		this.bot.action('admin_skip', this.handleAdminCallback.bind(this));

		// Обработка ошибок
		this.bot.catch(this.handleError.bind(this));
	}

	private async handleStart(ctx: MyContext): Promise<void> {
		await ctx.reply(
				`Привет, ${ctx.from?.first_name}! Отправь мне сообщение, и я перешлю его администратору на рассмотрение.`
		);
	}

	private async handleUserMessage(ctx: MyContext): Promise<void> {
		const user = ctx.from;
		const message = ctx.message;

		if (!user || !message) return;

		// Генерируем уникальный ключ для временного хранения
		const tempKey = `temp_${user.id}_${message.message_id}`;

		// Временно сохраняем сообщение до выбора пользователя
		const tempMessage: PendingMessage = {
			userId: user.id,
			userName: user.first_name,
			username: user.username,
			messageId: message.message_id,
			chatId: ctx.chat!.id,
			text: this.getMessageText(message),
			contentType: this.getMessageType(message),
			media: this.getMediaData(message),
			timestamp: Date.now(),
			publishType: 'pending' // будет установлен пользователем
		};

		// Сохраняем сообщение с правильным ключом
		this.state.pendingMessages.set(tempKey, tempMessage);

		// Отправляем кнопки выбора
		const choiceMessage = await ctx.reply(
				'Как вы хотите опубликовать сообщение?',
				Markup.inlineKeyboard([
					[
						Markup.button.callback('📝 С моим именем', `user_choice:with_name:${message.message_id}`),
						Markup.button.callback('👤 Анонимно', `user_choice:anonymous:${message.message_id}`)
					],
					[Markup.button.callback('❌ Отменить отправку', `user_choice:cancel:${message.message_id}`)]
				])
		);

		// Также сохраняем ID сообщения с кнопками для возможного редактирования
		this.state.pendingMessages.set(`choice_${message.message_id}`, {
			...tempMessage,
			choiceMessageId: choiceMessage.message_id
		} as any);
	}

	private async handleUserChoice(ctx: MyContext, next: () => Promise<void>): Promise<void> {
		// Проверяем, что это callback_query
		if (!('callback_query' in ctx.update)) {
			return next();
		}

		const callbackQuery = ctx.update.callback_query;
		if (!callbackQuery || !('data' in callbackQuery)) return next();

		const callbackData = callbackQuery.data;
		const user = ctx.from;

		if (!user || !callbackData.startsWith('user_choice:')) return next();

		const parts = callbackData.split(':');
		const choice = parts[1];
		const originalMessageId = parseInt(parts[2]);

		// Ищем сообщение по правильному ключу
		const tempKey = `temp_${user.id}_${originalMessageId}`;
		const tempMessage = this.state.pendingMessages.get(tempKey);

		if (!tempMessage) {
			await ctx.answerCbQuery('Сообщение не найдено или время ожидания истекло.');
			return;
		}

		try {
			switch (choice) {
				case 'cancel':
					await ctx.editMessageText('❌ Отправка отменена.');
					// Удаляем временные данные
					this.state.pendingMessages.delete(tempKey);
					this.state.pendingMessages.delete(`choice_${originalMessageId}`);
					break;

				case 'with_name':
				case 'anonymous':
					// Сохраняем выбранный тип публикации
					const finalMessage: PendingMessage = {
						...tempMessage,
						publishType: choice as 'with_name' | 'anonymous'
					};

					// Добавляем сообщение в очередь
					this.state.messageQueue.push(finalMessage);
					const messageIndex = this.state.messageQueue.length - 1;
					this.state.pendingMessages.set(messageIndex.toString(), finalMessage);

					// Удаляем временные сообщения
					this.state.pendingMessages.delete(tempKey);
					this.state.pendingMessages.delete(`choice_${originalMessageId}`);

					// Уведомляем пользователя
					await ctx.editMessageText(
							choice === 'with_name' ?
									'✅ Сообщение отправлено администратору на рассмотрение (будет опубликовано с вашим именем)!' :
									'✅ Сообщение отправлено администратору на рассмотрение (будет опубликовано анонимно)!'
					);

					// Если это первое сообщение в очереди, показываем его админу
					if (this.state.messageQueue.length === 1) {
						await this.showNextMessageToAdmin();
					}
					break;
			}

			await ctx.answerCbQuery();
		} catch (error) {
			console.error('Error handling user choice:', error);
			await ctx.answerCbQuery('Произошла ошибка.');
		}
	}

	private async handleAdminCallback(ctx: MyContext): Promise<void> {
		// Проверяем, что это callback_query
		if (!('callback_query' in ctx.update)) {
			return;
		}

		const callbackQuery = ctx.update.callback_query;
		if (!callbackQuery || !('data' in callbackQuery)) return;

		const callbackData = callbackQuery.data;
		const adminId = parseInt(process.env.ADMIN_ID!);

		// Проверяем, что действие совершает администратор
		if (ctx.from?.id !== adminId) {
			await ctx.answerCbQuery('У вас нет прав для этого действия.');
			return;
		}

		try {
			switch (callbackData) {
				case 'admin_approve':
					await this.handleApprove(ctx);
					break;
				case 'admin_reject':
					await this.handleReject(ctx);
					break;
				case 'admin_skip':
					await this.handleSkip(ctx);
					break;
				default:
					await ctx.answerCbQuery('Неизвестное действие.');
					return;
			}

			// Удаляем сообщение с кнопками
			if (ctx.callbackQuery?.message) {
				try {
					await ctx.deleteMessage();
				} catch (deleteError) {
					console.error('Error deleting admin message:', deleteError);
				}
			}

			await ctx.answerCbQuery();
		} catch (error) {
			console.error('Error handling admin callback:', error);
			await ctx.answerCbQuery('Произошла ошибка.');
		}
	}

	private getMessageText(message: any): string | undefined {
		if ('text' in message) return message.text;
		if ('caption' in message) return message.caption;
		return undefined;
	}

	private getMessageType(message: any): string {
		if ('text' in message) return 'text';
		if ('photo' in message) return 'photo';
		if ('video' in message) return 'video';
		if ('document' in message) return 'document';
		if ('audio' in message) return 'audio';
		return 'unknown';
	}

	private getMediaData(message: any): PendingMessage['media'] | undefined {
		if ('photo' in message && message.photo) {
			return {
				fileId: message.photo[message.photo.length - 1].file_id,
				type: 'photo',
				caption: message.caption
			};
		}
		if ('video' in message && message.video) {
			return {
				fileId: message.video.file_id,
				type: 'video',
				caption: message.caption
			};
		}
		if ('document' in message && message.document) {
			return {
				fileId: message.document.file_id,
				type: 'document',
				caption: message.caption
			};
		}
		if ('audio' in message && message.audio) {
			return {
				fileId: message.audio.file_id,
				type: 'audio',
				caption: message.caption
			};
		}
		return undefined;
	}

	private async showNextMessageToAdmin(): Promise<void> {
		if (this.state.messageQueue.length === 0) {
			await this.sendToAdmin('Очередь сообщений пуста.');
			return;
		}

		const currentMessage = this.state.messageQueue[this.state.currentMessageIndex];
		await this.sendMessageToAdmin(currentMessage);
	}

	private async sendMessageToAdmin(message: PendingMessage): Promise<void> {
		const adminId = parseInt(process.env.ADMIN_ID!);
		const caption = this.formatMessageCaption(message);

		try {
			if (message.media) {
				// Отправляем медиа-сообщение
				switch (message.media.type) {
					case 'photo':
						await this.bot.telegram.sendPhoto(adminId, message.media.fileId, {
							caption: caption,
							parse_mode: 'HTML',
							...this.getAdminActionButtons()
						});
						break;
					case 'video':
						await this.bot.telegram.sendVideo(adminId, message.media.fileId, {
							caption: caption,
							parse_mode: 'HTML',
							...this.getAdminActionButtons()
						});
						break;
					case 'document':
						await this.bot.telegram.sendDocument(adminId, message.media.fileId, {
							caption: caption,
							parse_mode: 'HTML',
							...this.getAdminActionButtons()
						});
						break;
					case 'audio':
						await this.bot.telegram.sendAudio(adminId, message.media.fileId, {
							caption: caption,
							parse_mode: 'HTML',
							...this.getAdminActionButtons()
						});
						break;
				}
			} else if (message.text) {
				// Отправляем текстовое сообщение
				await this.bot.telegram.sendMessage(adminId, caption, {
					parse_mode: 'HTML',
					...this.getAdminActionButtons()
				});
			}
		} catch (error) {
			console.error('Error sending message to admin:', error);
		}
	}

	private formatMessageCaption(message: PendingMessage): string {
		let caption = `<b>📨 Новое сообщение от пользователя:</b>\n\n`;
		caption += `<b>👤 Имя:</b> ${message.userName}\n`;
		if (message.username) {
			caption += `<b>📱 Username:</b> @${message.username}\n`;
		}
		caption += `<b>🆔 ID:</b> ${message.userId}\n`;
		caption += `<b>📢 Тип публикации:</b> ${message.publishType === 'with_name' ? 'С именем автора' : 'Анонимно'}\n\n`;

		if (message.text) {
			caption += `<b>📝 Текст сообщения:</b>\n${message.text}\n\n`;
		} else if (message.media?.caption) {
			caption += `<b>📝 Подпись:</b>\n${message.media.caption}\n\n`;
		}

		caption += `<b>⏰ Время:</b> ${new Date(message.timestamp).toLocaleString('ru-RU')}`;

		return caption;
	}

	private getAdminActionButtons(): any {
		return Markup.inlineKeyboard([
			[Markup.button.callback('✅ Опубликовать', 'admin_approve')],
			[Markup.button.callback('❌ Отклонить', 'admin_reject')],
			[Markup.button.callback('⏭️ Пропустить', 'admin_skip')]
		]);
	}

	private async handleApprove(ctx: MyContext): Promise<void> {
		const currentMessage = this.state.messageQueue[this.state.currentMessageIndex];

		if (!currentMessage) {
			await ctx.answerCbQuery('Сообщение не найдено.');
			return;
		}

		try {
			// Публикуем в канал согласно выбору пользователя
			await this.publishToChannel(currentMessage);

			// Уведомляем пользователя
			await this.notifyUser(currentMessage.userId,
					'✅ Ваше сообщение было одобрено и опубликовано!' +
					(currentMessage.publishType === 'with_name' ? ' (с вашим именем)' : ' (анонимно)')
			);

			// Переходим к следующему сообщению
			await this.moveToNextMessage();
		} catch (error) {
			console.error('Error in handleApprove:', error);
			throw error;
		}
	}

	private async handleReject(ctx: MyContext): Promise<void> {
		const currentMessage = this.state.messageQueue[this.state.currentMessageIndex];

		if (!currentMessage) {
			await ctx.answerCbQuery('Сообщение не найдено.');
			return;
		}

		// Уведомляем пользователя
		await this.notifyUser(currentMessage.userId, '❌ Ваше сообщение было отклонено.');

		// Переходим к следующему сообщению
		await this.moveToNextMessage();
	}

	private async handleSkip(ctx: MyContext): Promise<void> {
		// Просто переходим к следующему сообщению
		await this.moveToNextMessage();
	}

	private async moveToNextMessage(): Promise<void> {
		// Удаляем текущее сообщение из очереди
		this.state.pendingMessages.delete(this.state.currentMessageIndex.toString());
		this.state.messageQueue.splice(this.state.currentMessageIndex, 1);

		// Если очередь пуста, сбрасываем индекс
		if (this.state.messageQueue.length === 0) {
			this.state.currentMessageIndex = 0;
			await this.sendToAdmin('✅ Все сообщения обработаны!');
		} else {
			// Показываем следующее сообщение
			await this.showNextMessageToAdmin();
		}
	}

	private async publishToChannel(message: PendingMessage): Promise<void> {
		const channelId = process.env.CHANNEL_ID;

		if (!channelId) {
			throw new Error('CHANNEL_ID is not configured');
		}

		// HTML разметка для подписи
		const signature = `\n\n<a href="https://t.me/${this.botUsername}">Предложка</a>`;

		try {
			// Формируем финальное сообщение согласно выбору пользователя
			let finalCaption = '';
			let finalText = '';

			if (message.publishType === 'with_name') {
				// С именем автора
				const authorInfo = `От: ${message.userName}${message.username ? ` (@${message.username})` : ''}`;

				if (message.media) {
					finalCaption = authorInfo;
					if (message.media.caption) {
						finalCaption += `\n\n${message.media.caption}`;
					}
				} else if (message.text) {
					finalText = `${authorInfo}\n\n${message.text}`;
				}
			} else {
				// Анонимно
				if (message.media && message.media.caption) {
					finalCaption = message.media.caption;
				} else if (message.text) {
					finalText = message.text;
				}
			}

			// Добавляем подпись
			if (message.media) {
				finalCaption = finalCaption ? finalCaption + signature : signature;
			} else {
				finalText = finalText ? finalText + signature : signature;
			}

			// Для HTML экранируем только специальные символы HTML
			const escapeHTML = (text: string): string => {
				return text
						.replace(/&/g, '&amp;')
						.replace(/</g, '&lt;')
						.replace(/>/g, '&gt;');
			};

			if (message.media) {
				// Публикуем медиа в канал с HTML разметкой
				const options = {
					caption: finalCaption ? escapeHTML(finalCaption) : undefined,
					parse_mode: 'HTML' as const
				};

				switch (message.media.type) {
					case 'photo':
						await this.bot.telegram.sendPhoto(channelId, message.media.fileId, options);
						break;
					case 'video':
						await this.bot.telegram.sendVideo(channelId, message.media.fileId, options);
						break;
					case 'document':
						await this.bot.telegram.sendDocument(channelId, message.media.fileId, options);
						break;
					case 'audio':
						await this.bot.telegram.sendAudio(channelId, message.media.fileId, options);
						break;
				}
			} else if (message.text) {
				// Публикуем текст в канал с HTML разметкой
				await this.bot.telegram.sendMessage(channelId, escapeHTML(finalText), {
					parse_mode: 'HTML' as const
				});
			}
		} catch (error) {
			console.error('Error publishing to channel:', error);
			throw error;
		}
	}
	
	private async notifyUser(userId: number, text: string): Promise<void> {
		try {
			await this.bot.telegram.sendMessage(userId, text);
		} catch (error) {
			console.error('Error notifying user:', error);
		}
	}

	private async sendToAdmin(text: string): Promise<void> {
		const adminId = parseInt(process.env.ADMIN_ID!);
		try {
			await this.bot.telegram.sendMessage(adminId, text);
		} catch (error) {
			console.error('Error sending message to admin:', error);
		}
	}

	private handleError(error: any): void {
		console.error('Bot error:', error);
	}

	public launch(): void {
		this.bot.launch().then(() => {
			console.log('Bot started successfully');
		});

		// Включить graceful stop
		process.once('SIGINT', () => this.bot.stop('SIGINT'));
		process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
	}
}

// Запуск бота
const bot = new MessageReviewBot();
bot.launch();
