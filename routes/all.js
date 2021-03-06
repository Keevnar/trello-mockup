var express = require('express');
var router = express.Router();

var status = require('http-status');
var createError = require('http-errors');

var db = require('../models/index');
var socket = require('../socket');

router.get('/all/:uid', function(req,res,next) {
    // setup
    let uid = req.params.uid;

    let query = `
        SELECT t.id "teamId", t.name "teamName", "tb"."boards"
        FROM (SELECT t.id, json_agg(b.*) AS "boards"
            FROM "boards" b
            LEFT JOIN "teams" t
                ON t."id" = "b"."teamId"
            LEFT JOIN "teamUsers" tu
                ON "tu"."teamId" = "t"."id"
            WHERE "b"."ownerId" = :id OR "tu"."userId" = :id
            GROUP BY t.id) tb
        LEFT JOIN "teams" t
            ON "t"."id" = "tb"."id"
        ORDER BY t."createdOn" DESC
    `;

    // execute query
    db.sequelize.query(query, {
        replacements: {
            id: uid
        },
        type: db.sequelize.QueryTypes.SELECT
    })
    .then( data => {
        res.status(200).json(data);
    })
    .error( err => {
        console.error(err);
        next(createError(err));
    });
});


/**
 *  socket message test
 */
var socket = require('../socket');
router.post('/socket', function(req,res,next) {
    let userId = req.session.user.id;
    let socketId = req.body.socketId;

    // let sock = socket.sockets()[userId];
    socket.invite(socketId);

    res.end();
});


/**
 *   for searching new team members
 */
router.get('/user', function(req,res,next) {
    console.log(req.query);

    // build raw query
    let query = `
        SELECT u."id", CONCAT(u."firstName",' ',u."lastName") AS "name"
        FROM "users" u
        WHERE CONCAT(u."firstName",' ',u."lastName") LIKE CONCAT('%',:name,'%');
    `;

    // execute query
    db.sequelize.query(query, {
        type: db.sequelize.QueryTypes.SELECT,
        replacements: req.query
    })
    .then( users => {
        console.log(users);
        res.status(200).json(users);
    })
    .catch( err => {
        console.error(err);
        next(err);
    })
});

/***************************/
/*  Create Notifications   */
/***************************/
router.post('/invite', function(req, res, next) {
    let senderId = req.body.senderId;
    let receiverId = req.body.receiverId;
    let teamId = req.body.teamId;

    if (!senderId || !receiverId || !teamId) {
        next(createError(400, 'one of the fields are missing'));
    }

    checkSenderBelongsInTeam(req, res, next);
})

function checkSenderBelongsInTeam(req, res, next) 
{
    // build query
    let query = `
        SELECT u."id", CONCAT(u."firstName",' ',u."lastName") AS "name"
        FROM "users" u
        INNER JOIN "teamUsers" tU on u.id = tU."userId"
        WHERE u."id" = :senderId and tU."teamId" = :teamId
    `;

    // execute query
    db.sequelize.query(query, {
        type: db.sequelize.QueryTypes.SELECT,
        replacements: req.body
    })
    .then( sqlres => {
        // check if sender is in team
        if (0 >= sqlres.length) {
            next(createError(400, 'sender does not belong in the team'));
            return;
        }

        req.body.senderName = sqlres[0].name;
        checkReceiverNotInTeam(req, res, next);
    })
    .catch( err => {
        console.error(err);
        next(err);
    })
}

function checkReceiverNotInTeam(req, res, next) 
{
    // build query
    let query = `
        SELECT u."id", CONCAT(u."firstName",' ',u."lastName") AS "name"
        FROM "users" u
        INNER JOIN "teamUsers" tU on u.id = tU."userId"
        WHERE u."id" = :receiverId and tU."teamId" = :teamId
    `;

    // execute query
    db.sequelize.query(query, {
        type: db.sequelize.QueryTypes.SELECT,
        replacements: req.body
    })
    .then( sqlres => {
        // check if receiver not in team
        if (0 < sqlres.length) {
            next(createError(400, 'receiver is already in the team'));
            return;
        }

        sendInvitation(req, res, next);
    })
    .catch( err => {
        console.error(err);
        next(err);
    })
}

function sendInvitation(req, res, next) 
{
    let senderName = req.body.senderName;
    let teamId = req.body.teamId;
    // build query
    let query = `
        INSERT INTO "invitations"
            ("senderId", "receiverId", "teamId", "createdOn")
        VALUES
            (:senderId, :receiverId, :teamId, NOW())
        RETURNING * ;
    `;

    // execute query
    db.sequelize.query(query, {
        type: db.sequelize.QueryTypes.INSERT,
        replacements: req.body
    })
    .then( sqlres => {
        getInvitationNames(sqlres, req, res, next)
    })
    .catch( err => {
        console.error(err);
        next(err);
    })
}

function getInvitationNames(inv, req, res, next)
{
    // build query
    let query = `
        SELECT CONCAT(u."firstName",' ',u."lastName") AS "senderName", t."name" AS "teamName"
        FROM "invitations" i
        INNER JOIN users u
                ON i."senderId" = u.id
        INNER JOIN teams t
                ON i."teamId" = t.id
        WHERE i."receiverId" = :receiverId;
    `;

    // execute query
    db.sequelize.query(query, {
        type: db.sequelize.QueryTypes.SELECT,
        replacements: inv[0][0]
    })
    .then( sqlres => {
        inv[0][0].senderName = sqlres[0].senderName;
        inv[0][0].teamName = sqlres[0].teamName;

        let sock = socket.sockets()[inv[0][0].receiverId];
        if (sock) {
            sock.emit('invitation', inv);
        }

        res.status(200).json(inv);
    })
    .catch( err => {
        console.error(err);
        next(err);
    })

}


/***************************/
/*   Get Notifications     */
/***************************/
router.get('/:receiverId/notifications', function(req,res,next) 
{
    // build query
    let query = `
        SELECT i."senderId" AS "senderId", CONCAT(u."firstName",' ',u."lastName") AS "senderName", t."id" AS "teamId", t."name" AS "teamName", i."createdOn" AS "date"
        FROM "invitations" i
        INNER JOIN users u
                ON i."senderId" = u.id
        INNER JOIN teams t
                ON i."teamId" = t.id
        WHERE i."receiverId" = :receiverId;
    `;

    // execute query
    db.sequelize.query(query, {
        type: db.sequelize.QueryTypes.SELECT,
        replacements: req.params
    })
    .then( sqlres => {
        res.status(200).json(sqlres);
    })
    .catch( err => {
        console.error(err);
        next(err);
    })
});

/***************************/
/*   Accept Invitation     */
/***************************/
router.post('/invitation/accept', function(req,res,next)
{
    // add receiver to team
    addMemberToTeam(req,res,next);
})

function addMemberToTeam(req,res,next) 
{
    // build query
    let query = `
        INSERT INTO "teamUsers"
            ("teamId", "userId","joinedAt")
        VALUES
            (:teamId, :receiverId, NOW())
        RETURNING * ;
    `;

    // execute query
    db.sequelize.query(query, {
        type: db.sequelize.QueryTypes.INSERT,
        replacements: req.body
    })
    .then( sqlres => {
        deleteInvitation(req,res,next);
    })
    .catch( err => {
        console.error(err);
        next(err);
    })
}

function deleteInvitation(req,res,next)
{
    // build query
    let query = `
        DELETE FROM "invitations" i
        WHERE i."senderId" = :senderId 
            AND i."receiverId" = :receiverId
            AND i."teamId" = :teamId
        RETURNING *;
    `;

    // execute query
    db.sequelize.query(query, {
        type: db.sequelize.QueryTypes.DELETE,
        replacements: req.body
    })
    .then( sqlres => {
        getTeamName(sqlres,req,res,next)
    })
    .catch( err => {
        console.error(err);
        next(err);
    })
}

function getTeamName(inv,req,res,next)
{
    // build query
    let query = `
        SELECT t."name"
        FROM "teams" t
        WHERE t."id" = :teamId
    `;

    // execute query
    db.sequelize.query(query, {
        type: db.sequelize.QueryTypes.DELETE,
        replacements: req.body
    })
    .then( sqlres => {
        inv[0].teamName = sqlres[0].name;
        res.status(200).json(inv);
    })
    .catch( err => {
        console.error(err);
        next(err);
    })
}

module.exports = router;