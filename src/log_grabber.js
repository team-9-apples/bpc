import {d1} from "../test/d1.js";

export async function get_logs(db,userid,org){
    try{
    if( await (db.prepare("SELECT  1 FROM users WHERE id=? AND role='REQUEST_USER' ").bind(userid).first())){
        return("wrong credentials") ;
    }
    else {

        let result =db.prepare('SELECT id,started_at from requests WHERE  organisation_id=?').bind(org).first();
        return result;

    }}
catch(err){
    return(err);}
}
export async function detail_log(db,logid){
    try {


    let log = db.prepare('SELECT * FROM CHECK_RESULTS WHERE id=?').bind(logid).first();
    console.log(log);
}catch(err){
    return(err);
    }
}