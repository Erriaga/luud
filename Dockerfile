FROM node:20

WORKDIR /app

# Copia e instala dependências
COPY package*.json ./
RUN npm install --production

# Copia o restante do código
COPY . .

# Porta que o server.js usa
ENV PORT=4000
EXPOSE 4000

# Inicia o servidor
CMD ["node", "server.js"]
