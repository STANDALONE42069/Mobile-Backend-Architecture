import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { createBullBoard } from '@bull-board/api';
import { ExpressAdapter } from '@bull-board/express';
import { Queue } from 'bullmq';
import express = require('express');
import { redisConnection } from './config';
import { ORDER_QUEUE } from './orders/orders.service';

const app = express();
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');
const queue = new Queue(ORDER_QUEUE, { connection: redisConnection() });
createBullBoard({ queues: [new BullMQAdapter(queue)], serverAdapter });
app.use('/admin/queues', serverAdapter.getRouter());
app.get('/health', (_request, response) => response.json({ status: 'ok' }));
const server = app.listen(Number(process.env.MONITOR_PORT ?? 3001), '0.0.0.0');

const shutdown = () => server.close(() => void queue.close().then(() => process.exit(0)));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
