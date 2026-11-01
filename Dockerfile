# syntax=docker/dockerfile:1
# صورة الإنتاج لخادم maa المرجعي (dist/dev-server.js). مرحلتان: البناء بكل الأدوات، ثم صورة صغيرة
# فيها الكود المترجم واعتماديات التشغيل فقط، وتعمل بمستخدم غير root.

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 3000
# /livez لا يلمس القاعدة: يعيد Docker تشغيل الحاوية فقط إن كانت العملية نفسها عالقة.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/livez').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# SIGTERM من docker stop يصل لـ node مباشرة (لا shell بينهما)، فيعمل الإيقاف اللطيف.
CMD ["node", "dist/dev-server.js"]
