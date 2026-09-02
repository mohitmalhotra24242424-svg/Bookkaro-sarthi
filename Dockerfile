# BookKaro backend — container image (Render / Hugging Face Spaces / any Docker host)
FROM node:20-slim
WORKDIR /app

# Install dependencies first (layer cache friendly)
COPY package.json package-lock.json ./
RUN npm ci

# Build the project (TypeScript -> dist/)
COPY . .
RUN npm run build

# Hugging Face Spaces routes traffic to 7860 by default; Render sets PORT itself.
ENV PORT=7860
EXPOSE 7860

# Keys are injected as runtime ENVIRONMENT VARIABLES by the host — never baked in.
CMD ["npm", "start"]
