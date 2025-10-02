FROM node

WORKDIR /app

# Копируем package.json и package-lock.json
COPY package*.json ./
COPY tsconfig.json ./

# Устанавливаем зависимости
RUN npm install

# Копируем исходный код
COPY . .

# Компилируем TypeScript
RUN npm run build

# Запускаем приложение
CMD ["node", "dist/bot.js"]
