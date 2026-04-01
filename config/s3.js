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
    if (matches.length !== 3) {
        throw new Error("String base64 inválida");
    }

    const mimeType = matches[1];
    const base64Data = matches[2];
    const buffer = Buffer.from(base64Data, 'base64');

    const extension = mimeType.split('/')[1];
    const uniqueFileName = `${crypto.randomBytes(16).toString('hex')}.${extension}`;
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