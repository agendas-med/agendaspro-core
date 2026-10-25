const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const crypto = require("crypto");

const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

const uploadImageToS3 = async (base64String, pathFolder) => {
    if (!base64String || !base64String.startsWith('data:image')) {
        return base64String;
    }

    const matches = base64String.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
        throw new Error("String base64 inválida");
    }

    const mimeType = matches[1];
    const base64Data = matches[2];
    const buffer = Buffer.from(base64Data, 'base64');

    const extension = mimeType.split('/')[1];
    if (!['png', 'jpeg', 'jpg', 'webp', 'gif'].includes(extension)) throw new Error('Formato de imagem não suportado.');
    const uniqueFileName = `${crypto.randomBytes(16).toString('hex')}.${extension}`;
    if (!process.env.AWS_S3_BUCKET) {
        const fs = require('node:fs/promises');
        const path = require('node:path');
        const directory = path.join(__dirname, '../public/uploads');
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(path.join(directory, uniqueFileName), buffer);
        return `${process.env.PUBLIC_API_URL || `http://localhost:${process.env.PORT || 3001}`}/public/uploads/${uniqueFileName}`;
    }
    const key = `${pathFolder}/${uniqueFileName}`;

    const command = new PutObjectCommand({
        Bucket: process.env.AWS_S3_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
        ACL: 'public-read'
    });

    await s3Client.send(command);

    return `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
};

module.exports = { uploadImageToS3 };
